const { randomUUID } = require('node:crypto')
const { lstatSync, realpathSync } = require('node:fs')
const { basename, isAbsolute } = require('node:path')
const { createInterface } = require('node:readline')
const { setTimeout: delay } = require('node:timers/promises')
const {
  DesktopControlError,
  DesktopSignInRequired,
  DesktopTemporarilyUnavailable,
  openDesktopConnection
} = require('./desktop-connection.cjs')

const turnTimeoutMs = 15 * 60 * 1000

function serve(profile, windowsSecurityModule) {
  const send = (message) =>
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
  let desktop
  let sessionId
  let active
  let changingModel = false
  let pendingModel
  let retryCatalog = false

  const update = (sessionId, update) =>
    send({ method: 'session/update', params: { sessionId, update } })

  function selectedModel(current, target) {
    if (
      current.scope !== target.scope ||
      current.session_id !== (target.session_id ?? null) ||
      typeof current.model !== 'string' ||
      desktop.containsAuthorization(current.model)
    ) {
      throw new DesktopControlError('QwenWork desktop did not return the expected model settings.')
    }
    return current.model
  }

  async function modelOptions(ownedSession, signal) {
    if (!desktop.supportsModelSelection()) {
      return []
    }
    const target = ownedSession
      ? { scope: 'session', session_id: ownedSession }
      : { scope: 'default' }
    const [catalog, current] = await Promise.allSettled([
      desktop.call('model.list', {}, signal),
      desktop.call('model.get', target, signal).then((model) => selectedModel(model, target))
    ])
    for (const result of [catalog, current]) {
      if (
        result.status === 'rejected' &&
        !(result.reason instanceof DesktopTemporarilyUnavailable)
      ) {
        throw result.reason
      }
    }
    if (catalog.status === 'rejected') {
      throw catalog.reason
    }
    if (current.status === 'rejected') {
      throw current.reason
    }
    if (!Array.isArray(catalog.value.models)) {
      throw new DesktopControlError('QwenWork desktop did not return the expected model settings.')
    }
    const options = catalog.value.models
      .filter(
        (model) =>
          model?.enabled === true &&
          typeof model.key === 'string' &&
          model.key.length > 0 &&
          model.key.length <= 512 &&
          typeof model.display_name === 'string' &&
          model.display_name.trim().length > 0 &&
          !desktop.containsAuthorization(model.key) &&
          !desktop.containsAuthorization(model.display_name)
      )
      .map((model) => ({ value: model.key, name: model.display_name }))
    if (options.length === 0) {
      return []
    }
    return [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: current.value,
        options
      }
    ]
  }

  async function readChatConfig(ownedSession, signal) {
    try {
      const config = await modelOptions(ownedSession, signal)
      retryCatalog = false
      return config
    } catch (error) {
      if (!(error instanceof DesktopTemporarilyUnavailable)) {
        throw error
      }
      retryCatalog = true
      return []
    }
  }

  async function readTask(method, params, run, signal) {
    await desktop.status(signal)
    const task = await desktop.call(method, params, signal)
    if (task.task_id !== run.taskId || task.session_id !== run.sessionId) {
      throw new DesktopControlError('The QwenWork desktop task does not match this chat.')
    }
    return task
  }

  async function prompt(params, requestId) {
    if (
      requestId == null ||
      !sessionId ||
      params.sessionId !== sessionId ||
      active ||
      changingModel
    ) {
      throw new DesktopControlError('This QwenWork chat is not ready for another message.')
    }
    if (
      !Array.isArray(params.prompt) ||
      params.prompt.some((part) => part?.type !== 'text' || typeof part.text !== 'string')
    ) {
      throw new DesktopControlError('This QwenWork chat accepts text messages.')
    }
    const message = params.prompt
      .map((part) => part.text)
      .join('\n')
      .trim()
    if (!message || message.length > 64000) {
      throw new DesktopControlError(
        'Enter a nonempty QwenWork message of at most 64000 characters.'
      )
    }
    const stop = new AbortController()
    const deadline = AbortSignal.timeout(turnTimeoutMs)
    const signal = AbortSignal.any([stop.signal, deadline])
    const run = { sessionId, requestId, taskId: randomUUID(), stop }
    active = run
    let terminal = false
    let submitted = false
    let emitted = ''
    const sendAnswer = (task, final) => {
      const answer = task.answer
      if (typeof answer === 'string' && desktop.containsAuthorization(answer)) {
        throw new DesktopControlError('QwenWork desktop returned an invalid answer.')
      }
      if (
        typeof answer !== 'string' ||
        task.answer_may_be_truncated === true ||
        !answer.startsWith(emitted)
      ) {
        if (final) {
          throw new DesktopControlError('QwenWork desktop did not return a complete answer.')
        }
        return
      }
      signal.throwIfAborted()
      const length = final
        ? answer.length
        : answer.length - desktop.pendingAuthorizationLength(answer)
      if (length > emitted.length) {
        update(run.sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: answer.slice(emitted.length, length) }
        })
        emitted = answer.slice(0, length)
      }
    }
    try {
      if (pendingModel) {
        await desktop.status(signal)
        const target = { scope: 'session', session_id: run.sessionId }
        const actual = selectedModel(await desktop.call('model.get', target, signal), target)
        const previous = pendingModel
        pendingModel = undefined
        if (actual !== previous.currentValue) {
          update(run.sessionId, {
            sessionUpdate: 'config_option_update',
            configOptions: [{ ...previous, currentValue: actual }]
          })
          throw new DesktopControlError(
            'QwenWork updated the current model. Check it and send again.'
          )
        }
      }
      if (retryCatalog) {
        await desktop.status(signal)
        const configOptions = await readChatConfig(run.sessionId, signal)
        if (configOptions.length) {
          update(run.sessionId, { sessionUpdate: 'config_option_update', configOptions })
        }
      }
      signal.throwIfAborted()
      submitted = true
      let task = await readTask(
        'task.submit',
        { session_id: run.sessionId, request_id: run.taskId, prompt: message },
        run,
        signal
      )
      while (task.terminal !== true) {
        sendAnswer(task, false)
        await delay(500, undefined, { signal })
        task = await readTask('task.get', { task_id: run.taskId }, run, signal)
      }
      terminal = true
      if (task.status === 'cancelled') {
        return { stopReason: 'cancelled' }
      }
      if (task.status !== 'completed') {
        throw new DesktopControlError('QwenWork desktop did not complete this message.')
      }
      const result = await readTask('task.result', { task_id: run.taskId }, run, signal)
      if (
        result.status !== 'completed' ||
        result.answer_is_final !== true ||
        result.answer_may_be_truncated === true ||
        typeof result.answer !== 'string' ||
        !result.answer.trim()
      ) {
        throw new DesktopControlError('QwenWork desktop did not return a complete answer.')
      }
      sendAnswer(result, true)
      return { stopReason: 'end_turn' }
    } catch (error) {
      if (stop.signal.aborted) {
        if (submitted && !terminal) {
          const confirmation = AbortSignal.timeout(12000)
          const target = { task_id: run.taskId }
          let stopped = await readTask('task.cancel', target, run, confirmation).catch(
            () => undefined
          )
          if (stopped?.terminal !== true) {
            stopped = await readTask('task.get', target, run, confirmation).catch(() => undefined)
          }
          if (stopped?.terminal !== true) {
            throw new DesktopControlError('Could not confirm that QwenWork stopped this reply.')
          }
        }
        return { stopReason: 'cancelled' }
      }
      if (deadline.aborted) {
        throw new DesktopControlError('QwenWork timed out waiting for this reply. Try again.')
      }
      throw error
    } finally {
      if (submitted && !terminal && !stop.signal.aborted) {
        await readTask('task.cancel', { task_id: run.taskId }, run).catch(() => {})
      }
      active = undefined
    }
  }

  async function handle(method, params, id) {
    if (method === 'initialize') {
      desktop = openDesktopConnection(profile, windowsSecurityModule)
      const version = await desktop.status()
      return {
        protocolVersion: 1,
        agentInfo: { name: 'QwenWork', version: typeof version === 'string' ? version : 'desktop' },
        agentCapabilities: { sessionCapabilities: { resume: {} } }
      }
    }
    if (!desktop) {
      throw new DesktopControlError('Initialize the QwenWork desktop chat first.')
    }
    if (method === '_qwenwork/models') {
      await desktop.status()
      const [model] = await modelOptions()
      return {
        models: (model?.options ?? []).map((choice) => ({
          id: choice.value,
          label: choice.name,
          isDefault: choice.value === model.currentValue,
          efforts: []
        }))
      }
    }
    if (method === 'session/new') {
      if (typeof params.cwd !== 'string' || !isAbsolute(params.cwd)) {
        throw new DesktopControlError('Choose an Orca workspace folder for this QwenWork chat.')
      }
      const workspace = realpathSync(params.cwd)
      if (!lstatSync(workspace).isDirectory()) {
        throw new DesktopControlError('Choose an Orca workspace folder for this QwenWork chat.')
      }
      await desktop.status()
      const data = await desktop.call('session.create', {
        title: 'Orca',
        project_name: `Orca · ${basename(workspace)}`.slice(0, 200),
        working_directories: [workspace]
      })
      sessionId = readSessionId(data.session_id)
      pendingModel = undefined
      return { sessionId, configOptions: await readChatConfig(sessionId) }
    }
    if (method === 'session/resume') {
      const requested = readSessionId(params.sessionId)
      await desktop.status()
      const data = await desktop.call('session.get', { session_id: requested })
      if (data.session?.session_id !== requested) {
        throw new DesktopControlError('The QwenWork desktop session does not match this chat.')
      }
      sessionId = requested
      pendingModel = undefined
      return { configOptions: await readChatConfig(sessionId) }
    }
    if (method === 'session/set_config_option') {
      if (
        active ||
        changingModel ||
        !sessionId ||
        params.sessionId !== sessionId ||
        params.configId !== 'model'
      ) {
        throw new DesktopControlError('QwenWork can change models only for this idle chat.')
      }
      changingModel = true
      const ownedSession = sessionId
      try {
        await desktop.status()
        const [model] = await modelOptions(ownedSession)
        if (!model?.options.some((choice) => choice.value === params.value)) {
          throw new DesktopControlError('This model is unavailable in QwenWork desktop.')
        }
        const target = { scope: 'session', session_id: ownedSession }
        pendingModel ??= model
        let actual = selectedModel(
          await desktop.call('model.set', { ...target, model: params.value }),
          target
        )
        if (actual !== params.value) {
          // Some desktop versions acknowledge the write with the previous model.
          actual = selectedModel(await desktop.call('model.get', target), target)
        }
        if (actual !== params.value) {
          throw new DesktopControlError('QwenWork desktop did not confirm the selected model.')
        }
        pendingModel = undefined
        retryCatalog = false
        return { configOptions: [{ ...model, currentValue: actual }] }
      } finally {
        changingModel = false
      }
    }
    if (method === 'session/prompt') {
      return prompt(params, id)
    }
    if (
      method === 'session/cancel' ||
      method === 'session/close' ||
      method === '$/cancel_request'
    ) {
      if (
        active &&
        (method === '$/cancel_request'
          ? params.requestId === active.requestId
          : params.sessionId === active.sessionId)
      ) {
        active.stop.abort()
      }
      return {}
    }
    throw Object.assign(new Error('This QwenWork desktop chat does not support this operation.'), {
      code: -32601
    })
  }

  input.on('line', (line) => {
    let request
    try {
      request = JSON.parse(line)
    } catch {
      return
    }
    if (request?.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      return
    }
    const { id, method, params = {} } = request
    void handle(method, params, id).then(
      (result) => {
        if (id !== undefined) {
          send({ id, result })
        }
      },
      (error) => {
        if (id !== undefined) {
          const message =
            error instanceof DesktopControlError
              ? error.message
              : 'QwenWork desktop control is unavailable.'
          const code = error instanceof DesktopSignInRequired ? -32000 : (error?.code ?? -32603)
          send({ id, error: { code: typeof code === 'number' ? code : -32603, message } })
        }
      }
    )
  })
  input.on('close', () => {
    active?.stop.abort()
  })
  process.once('SIGTERM', () => input.close())
}

function readSessionId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) {
    throw new DesktopControlError('Invalid QwenWork desktop session.')
  }
  return value
}

serve(process.argv[2], process.argv[3])
