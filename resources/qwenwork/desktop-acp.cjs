const { randomUUID } = require('node:crypto')
const { lstatSync, realpathSync } = require('node:fs')
const { basename, isAbsolute } = require('node:path')
const { createInterface } = require('node:readline')
const { setTimeout: delay } = require('node:timers/promises')
const {
  DesktopControlError,
  DesktopSignInRequired,
  openDesktopConnection
} = require('./desktop-connection.cjs')

function serve(profile, windowsSecurityModule) {
  const send = (message) =>
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
  let desktop
  let sessionId
  let active
  let changingModel = false

  async function modelOptions(ownedSession) {
    if (!desktop.supportsModelSelection()) {
      return []
    }
    const target = ownedSession
      ? { scope: 'session', session_id: ownedSession }
      : { scope: 'default' }
    const [catalog, current] = await Promise.all([
      desktop.call('model.list', {}),
      desktop.call('model.get', target)
    ])
    if (
      !Array.isArray(catalog.models) ||
      current.scope !== target.scope ||
      current.session_id !== (ownedSession ?? null) ||
      typeof current.model !== 'string' ||
      desktop.containsAuthorization(current.model)
    ) {
      throw new DesktopControlError('QwenWork desktop did not return the expected model settings.')
    }
    const options = catalog.models
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
        currentValue: current.model,
        options
      }
    ]
  }

  async function readTask(method, params, run) {
    await desktop.status()
    const task = await desktop.call(method, params)
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
    const run = { sessionId, requestId, taskId: randomUUID(), cancelRequested: false }
    active = run
    let terminal = false
    try {
      let task = await readTask(
        'task.submit',
        { session_id: run.sessionId, request_id: run.taskId, prompt: message },
        run
      )
      while (task.terminal !== true && !run.cancelRequested) {
        await delay(500)
        if (!run.cancelRequested) {
          task = await readTask('task.get', { task_id: run.taskId }, run)
        }
      }
      if (task.terminal !== true && run.cancelRequested) {
        task = await readTask('task.cancel', { task_id: run.taskId }, run)
      }
      terminal = task.terminal === true
      if (terminal && task.status === 'cancelled') {
        return { stopReason: 'cancelled' }
      }
      if (!terminal || task.status !== 'completed') {
        throw new DesktopControlError('QwenWork desktop did not complete this message.')
      }
      const result = await readTask('task.result', { task_id: run.taskId }, run)
      if (
        result.status !== 'completed' ||
        result.answer_is_final !== true ||
        result.answer_may_be_truncated === true ||
        typeof result.answer !== 'string' ||
        !result.answer.trim() ||
        desktop.containsAuthorization(result.answer)
      ) {
        throw new DesktopControlError('QwenWork desktop did not return a complete answer.')
      }
      send({
        method: 'session/update',
        params: {
          sessionId: run.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: result.answer }
          }
        }
      })
      return { stopReason: 'end_turn' }
    } finally {
      if (!terminal) {
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
        agentCapabilities: { loadSession: true }
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
      return { sessionId, configOptions: await modelOptions(sessionId) }
    }
    if (method === 'session/load') {
      const requested = readSessionId(params.sessionId)
      await desktop.status()
      const data = await desktop.call('session.get', { session_id: requested })
      if (data.session?.session_id !== requested) {
        throw new DesktopControlError('The QwenWork desktop session does not match this chat.')
      }
      sessionId = requested
      return { configOptions: await modelOptions(sessionId) }
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
        await desktop.call('model.set', {
          scope: 'session',
          session_id: ownedSession,
          model: params.value
        })
        const configOptions = await modelOptions(ownedSession)
        if (configOptions[0]?.currentValue !== params.value) {
          throw new DesktopControlError('QwenWork desktop did not confirm the selected model.')
        }
        return { configOptions }
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
        active.cancelRequested = true
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
    if (active) {
      active.cancelRequested = true
    }
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
