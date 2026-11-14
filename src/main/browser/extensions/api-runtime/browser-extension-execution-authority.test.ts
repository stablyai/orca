import { expect, it } from 'vitest'
import { ensureHostSessionState, forgetHostSession } from './browser-extension-contexts'
import {
  beginBrowserExtensionExecution,
  browserExtensionBootstrapAuthority,
  browserExtensionContentAuthority,
  browserExtensionWorkerAuthority,
  retireBrowserExtensionExecution,
  trackBrowserExtensionExecutionOperation
} from './browser-extension-execution-authority'

it('revokes old credentials immediately and retains its files until admitted work settles', async () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The owned fixture supplies the session identity and lifecycle methods accessed by this production path.
  const session = {} as Electron.Session
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The owned fixture supplies the session identity and lifecycle methods accessed by this production path.
  const other = {} as Electron.Session
  ensureHostSessionState(session, 'work')
  ensureHostSessionState(other, 'other')
  const execution = beginBrowserExtensionExecution(session, 'vault', new AbortController().signal)
  const order: string[] = []
  let finish: () => void = () => {}
  const nativeWork = trackBrowserExtensionExecutionOperation(
    execution,
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  await Promise.resolve()
  execution.release = async () => {
    order.push('released old files')
  }
  expect(browserExtensionBootstrapAuthority(execution.bootstrap, other)).toBeNull()
  expect(browserExtensionWorkerAuthority(execution.workerToken, session, 'other')).toBeNull()
  const retired = retireBrowserExtensionExecution(session, 'vault')
  expect(browserExtensionBootstrapAuthority(execution.bootstrap, session)).toBeNull()
  expect(browserExtensionContentAuthority(execution.contentToken, session)).toBeNull()
  expect(browserExtensionWorkerAuthority(execution.workerToken, session, 'vault')).toBeNull()
  const successor = beginBrowserExtensionExecution(session, 'vault', new AbortController().signal)
  expect(browserExtensionBootstrapAuthority(successor.bootstrap, session)).toBe(successor)
  expect(order).toEqual([])
  finish()
  await nativeWork
  await retired
  expect(order).toEqual(['released old files'])
  expect(browserExtensionBootstrapAuthority(successor.bootstrap, session)).toBe(successor)
  await retireBrowserExtensionExecution(session, 'vault')
  forgetHostSession(session)
  forgetHostSession(other)
})
