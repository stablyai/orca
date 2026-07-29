import { getActiveMultiplexer } from './ssh'

const SSH_CONNECTION_UNAVAILABLE_MESSAGE =
  'SSH connection is not available. Please reconnect and try again.'

type SshRootRegistrationMux = {
  request: (method: 'session.registerRoot', payload: { rootPath: string }) => Promise<unknown>
  notify: (method: 'session.registerRoot', payload: { rootPath: string }) => void
}

async function registerSshWorktreeCreateRoots(
  mux: SshRootRegistrationMux,
  rootPaths: string[]
): Promise<void> {
  try {
    await Promise.all(
      rootPaths.map((rootPath) => mux.request('session.registerRoot', { rootPath }))
    )
  } catch (err) {
    if (err instanceof Error && err.message.includes('Method not found')) {
      for (const rootPath of rootPaths) {
        mux.notify('session.registerRoot', { rootPath })
      }
      return
    }
    throw err
  }
}

export async function registerOptionalSshWorktreeCreateRoots(
  connectionId: string,
  rootPaths: string[]
): Promise<void> {
  const mux = getActiveMultiplexer(connectionId)
  if (!mux) {
    return
  }
  await registerSshWorktreeCreateRoots(mux, rootPaths)
}

export async function registerRequiredSshWorktreeCreateRoots(
  connectionId: string,
  rootPaths: string[]
): Promise<void> {
  const mux = getActiveMultiplexer(connectionId)
  if (!mux) {
    throw new Error(SSH_CONNECTION_UNAVAILABLE_MESSAGE)
  }
  await registerSshWorktreeCreateRoots(mux, rootPaths)
}
