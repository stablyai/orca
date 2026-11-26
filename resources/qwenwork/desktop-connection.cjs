const { constants, closeSync, fstatSync, lstatSync, openSync, readSync } = require('node:fs')
const { request } = require('node:http')
const { isAbsolute, join, toNamespacedPath } = require('node:path')

const protocol = 'qwenwork.desktop.v1'
const maxResponseBytes = 1024 * 1024

class DesktopControlError extends Error {}
class DesktopSignInRequired extends DesktopControlError {}
class DesktopTemporarilyUnavailable extends DesktopControlError {}

function rethrowRequestError(error) {
  if (['ABORT_ERR', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(error?.code)) {
    throw new DesktopTemporarilyUnavailable(
      'QwenWork desktop did not respond. Check local control and try again.'
    )
  }
  throw error
}

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

function windowsControlFiles(modulePath) {
  if (!modulePath || !isAbsolute(modulePath)) {
    throw new DesktopControlError('QwenWork needs Windows credential-file protection.')
  }
  const security = require(modulePath)
  const privateSids = new Set([security.currentUserSid(), 'S-1-5-18', 'S-1-5-32-544'])
  const isPrivate = (dacl) =>
    dacl?.aces.every((ace) => ace.type === 1 || (ace.type === 0 && privateSids.has(ace.sid)))
  return {
    privateDirectory: (path) => isPrivate(security.getDaclAces(toNamespacedPath(path))),
    readFile: (path, limit) => {
      const file = security.readFileWithDacl(toNamespacedPath(path), limit)
      if (!file) {
        throw Object.assign(new Error('Control file is missing'), { code: 'ENOENT' })
      }
      if (!isPrivate(file.dacl)) {
        throw new DesktopControlError('Invalid QwenWork desktop control file permissions.')
      }
      return file.data.toString('utf8')
    }
  }
}

function readEndpoint(profile, windows) {
  const control = join(profile, 'cli-control')
  function requirePrivateDirectory(path) {
    const info = lstatSync(path)
    if (
      !info.isDirectory() ||
      !(windows
        ? windows.privateDirectory(path)
        : info.uid === process.getuid() && (info.mode & 0o077) === 0)
    ) {
      throw new DesktopControlError('Invalid QwenWork desktop control directory.')
    }
  }
  const readFile = windows?.readFile ?? readPrivateFile
  let endpoint
  try {
    requirePrivateDirectory(control)
    endpoint = JSON.parse(readFile(join(control, 'endpoint.json'), 4096))
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
  const authorization = readFile(join(instance, 'token'), 256).trim()
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

function openDesktopConnection(profile, windowsSecurityModule) {
  const windows = process.platform === 'win32' ? windowsControlFiles(windowsSecurityModule) : null
  const endpoint = readEndpoint(profile, windows)
  let account
  let supportsModelSelection = false
  async function call(method, params, signal) {
    const current = readEndpoint(profile, windows)
    if (
      current.instanceId !== endpoint.instanceId ||
      current.authorization !== endpoint.authorization ||
      current.port !== endpoint.port
    ) {
      throw new DesktopControlError('QwenWork desktop restarted. Launch the chat again.')
    }
    const timeout = AbortSignal.timeout(12000)
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
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout
        },
        resolve
      )
      outgoing.on('error', reject)
      outgoing.end(body)
    }).catch(rethrowRequestError)
    if (response.headers['x-qwenwork-instance'] !== endpoint.instanceId) {
      response.destroy()
      throw new DesktopControlError('QwenWork desktop instance does not match.')
    }
    if ([429, 502, 503, 504].includes(response.statusCode)) {
      response.destroy()
      throw new DesktopTemporarilyUnavailable(
        'QwenWork desktop is temporarily unavailable. Try again.'
      )
    }
    const result = await readResponse(response).catch(rethrowRequestError)
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
  async function status(signal) {
    const data = await call('desktop.status', {}, signal)
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
    supportsModelSelection = data.features.model_selection === true
    return data.app?.version
  }
  return {
    call,
    status,
    supportsModelSelection: () => supportsModelSelection,
    containsAuthorization: (text) => text.includes(endpoint.authorization),
    pendingAuthorizationLength: (text) => {
      // A response may split a credential across polls.
      for (
        let length = Math.min(text.length, endpoint.authorization.length - 1);
        length > 0;
        length--
      ) {
        if (endpoint.authorization.startsWith(text.slice(-length))) {
          return length
        }
      }
      return 0
    }
  }
}

module.exports = {
  DesktopControlError,
  DesktopSignInRequired,
  DesktopTemporarilyUnavailable,
  openDesktopConnection
}
