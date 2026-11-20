import { afterEach, expect, it, vi } from 'vitest'
import { partialRuntimeStore } from '../construction/test-context/runtime-store-partial-fixture'
import { prepareAgentImagePathsOnHost } from './agent-image-preparation'

const image = vi.hoisted(() => ({
  resolve: vi.fn(async (path: string) => path),
  fit: vi.fn(async (_path: string) => 'C:\\Temp\\fit.png')
}))
vi.mock('../../ipc/filesystem/access/local-file-access-resolution', () => ({
  resolveLocalFileRequestPath: image.resolve
}))
vi.mock('../../wsl/filesystem/wsl-unc-access-gate', () => ({
  guardWslUncPathAccess: (_path: string, read: () => Promise<string>) => read()
}))
vi.mock('../../native-chat/agent-images/agent-image-fit-client', () => ({
  fitAgentImagePath: image.fit
}))
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  vi.clearAllMocks()
})

it('fits local WSL execution paths through the Windows file path and returns an execution path', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  const store = partialRuntimeStore()
  expect(await prepareAgentImagePathsOnHost(['/mnt/c/Users/me/shot.png'], store)).toEqual([
    '/mnt/c/Temp/fit.png'
  ])
  expect(image.resolve).toHaveBeenCalledWith(
    'C:\\Users\\me\\shot.png',
    { kind: 'chat-image' },
    store
  )
})

it('preserves the supplied path when a file needs no fitting or cannot be resolved here', async () => {
  image.resolve.mockResolvedValueOnce('/private/var/shot.png')
  image.fit.mockResolvedValueOnce('/private/var/shot.png')
  expect(await prepareAgentImagePathsOnHost(['/var/shot.png'], partialRuntimeStore())).toEqual([
    '/var/shot.png'
  ])
  image.resolve.mockRejectedValueOnce(new Error('Path access denied'))
  expect(
    await prepareAgentImagePathsOnHost(['\\\\nas\\share\\shot.png'], partialRuntimeStore())
  ).toEqual(['\\\\nas\\share\\shot.png'])
})
