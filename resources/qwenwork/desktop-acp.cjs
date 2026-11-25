const { randomUUID } = require('node:crypto')
const {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync
} = require('node:fs')
const { request } = require('node:http')
const { basename, isAbsolute, join } = require('node:path')
const { createInterface } = require('node:readline')
const { setTimeout: delay } = require('node:timers/promises')

const protocol = 'qwenwork.desktop.v1'
const maxResponseBytes = 1024 * 1024

class DesktopControlError extends Error {}
class DesktopSignInRequired extends DesktopControlError {}

function readPrivateFile(path, limit) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.size > limit) {
      throw new DesktopControlError('Invalid QwenWork desktop control file.')
    }
    const buffer = Buffer.alloc(limit + 1)
    const count = readSync(fd, buffer)
    if (count > limit || count !== stat.size) {
      throw new DesktopControlError('QwenWork desktop control file changed. Launch the chat again.')
    }
    return buffer.subarray(0, count).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

function readEndpoint(profile) {
  const control = join(profile, 'cli-control')
  function requirePrivateDirectory(path) {
    const info = lstatSync(path)
    if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) {
      throw new DesktopControlError('Invalid QwenWork desktop control directory.')
    }
  }
  let endpoint
  try {
    requirePrivateDirectory(control)
    endpoint = JSON.parse(readPrivateFile(join(control, 'endpoint.json'), 4096))
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new DesktopControlError('Start QwenWork desktop with local control enabled.')
    }
    throw error
  }
  const { port, instance_id: instanceId } = endpoint
  if (
    endpoint.protocol !== protocol ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    typeof instanceId !== 'string' ||
    !/^[0-9a-f]{32}$/.test(instanceId)
  ) {
    throw new DesktopControlError('Incompatible QwenWork desktop control endpoint.')
  }
  const instance = join(control, instanceId)
  requirePrivateDirectory(instance)
  const authorization = readPrivateFile(join(instance, 'token'), 256).trim()
  if (!/^[0-9a-f]{64}$/.test(authorization)) {
    throw new DesktopControlError('Invalid QwenWork desktop control authorization.')
  }
  return { port, instanceId, authorization }
}

async function readResponse(response) {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0
  let text = ''
  for await (const chunk of response) {
    bytes += chunk.byteLength
    if (bytes > maxResponseBytes) {
      throw new DesktopControlError('QwenWork desktop control response exceeded its limit.')
    }
    text += decoder.decode(chunk, { stream: true })
  }
  return JSON.parse(text + decoder.decode())
}

function openDesktopConnection(profile) {
  const endpoint = readEndpoint(profile)
  let account
  async function call(method, params) {
    const current = readEndpoint(profile)
    if (
      current.instanceId !== endpoint.instanceId ||
      current.authorization !== endpoint.authorization ||
      current.port !== endpoint.port
    ) {
      throw new DesktopControlError('QwenWork desktop restarted. Launch the chat again.')
    }
    const response = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ schema_version: 'qwenwork.desktop-request.v1', method, params })
      const outgoing = request(
        {
          hostname: '127.0.0.1',
          port: endpoint.port,
          path: '/v1/control',
          method: 'POST',
          // The credential stays on loopback regardless of a user's proxy configuration.
          agent: false,
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
            authorization: `Bearer ${endpoint.authorization}`
          },
          signal: AbortSignal.timeout(12000)
        },
        resolve
      )
      outgoing.on('error', reject)
      outgoing.end(body)
    })
    if (response.headers['x-qwenwork-instance'] !== endpoint.instanceId) {
      response.destroy()
      throw new DesktopControlError('QwenWork desktop instance does not match.')
    }
    const result = await readResponse(response)
    if (
      response.statusCode !== 200 ||
      result.schema_version !== 'qwenwork.response.v1' ||
      result.ok !== true ||
      !result.data ||
      result.data.backend !== 'desktop'
    ) {
      const code = result.error?.code
      const reason = typeof code === 'string' && /^[A-Z_]{3,60}$/.test(code) ? ` (${code})` : ''
      throw new DesktopControlError(`QwenWork desktop rejected ${method}${reason}.`)
    }
    return result.data
  }
  async function status() {
    const data = await call('desktop.status', {})
    if (
      data.authenticated !== true ||
      typeof data.user?.user_id !== 'string' ||
      !data.user.user_id
    ) {
      throw new DesktopSignInRequired('Sign in to QwenWork desktop before opening its Orca chat.')
    }
    if (
      data.protocol !== protocol ||
      data.features?.task_execution !== true ||
      data.features?.session_history !== true
    ) {
      throw new DesktopControlError('This QwenWork desktop does not support chat control.')
    }
    if (account !== undefined && account !== data.user.user_id) {
      throw new DesktopControlError(
        'The signed-in QwenWork account changed. Launch the chat again.'
      )
    }
    account = data.user.user_id
    return data.app?.version
  }
  return { call, status, containsAuthorization: (text) => text.includes(endpoint.authorization) }
}

function serve(profile) {
  const send = (message) =>
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
  let desktop
  let sessionId
  let active

  async function readTask(method, params, run) {
    await desktop.status()
    const task = await desktop.call(method, params)
    if (task.task_id !== run.taskId || task.session_id !== run.sessionId) {
      throw new DesktopControlError('The QwenWork desktop task does not match this chat.')
    }
    return task
  }

  async function prompt(params, requestId) {
    if (requestId == null || !sessionId || params.sessionId !== sessionId || active) {
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
      desktop = openDesktopConnection(profile)
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
      return { sessionId }
    }
    if (method === 'session/load') {
      const requested = readSessionId(params.sessionId)
      await desktop.status()
      const data = await desktop.call('session.get', { session_id: requested })
      if (data.session?.session_id !== requested) {
        throw new DesktopControlError('The QwenWork desktop session does not match this chat.')
      }
      sessionId = requested
      return {}
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

serve(process.argv[2])
