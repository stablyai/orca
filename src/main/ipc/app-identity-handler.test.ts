import { expect, it, vi } from 'vitest'

const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, () => unknown>() }))
vi.mock('electron', () => ({
  app: { isPackaged: true },
  ipcMain: { handle: (channel: string, handler: () => unknown) => handlers.set(channel, handler) }
}))
vi.mock('./renderer-shutdown-checkpoint', () => ({
  registerRendererShutdownCheckpointHandler() {}
}))
vi.mock('./keyboard/macos-keyboard-layout-change-notifications', () => ({
  registerMacKeyboardLayoutChangeNotifications() {}
}))
vi.mock('../app-profiles/app-profile', () => ({
  getAppProfile: () => ({ name: 'Orca - Work', bundleId: 'com.stablyai.orca.profile.work' })
}))

import { registerAppHandlers } from './app'

it("gives the renderer a profile app's own name", async () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: registration reads neither; only app:getIdentity runs.
  registerAppHandlers({} as never, { rendererCheckpoint: {} as never })
  expect(await handlers.get('app:getIdentity')?.()).toMatchObject({
    name: 'Orca - Work',
    isDev: false
  })
})
