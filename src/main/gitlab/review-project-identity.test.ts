import { beforeEach, expect, it, vi } from 'vitest'
const { read, signature } = vi.hoisted(() => ({ read: vi.fn(), signature: vi.fn() }))
vi.mock('./gl-utils', () => ({
  glabExecFileAsync: read,
  glabHostnameArgs: () => [],
  glabRepoExecOptions: (cwd: string) => ({ cwd })
}))
vi.mock('../github/local-git-config-signature', () => ({ readLocalGitConfigSignature: signature }))
import {
  readReviewProjectIdentity,
  resetReviewProjectIdentitiesForTest
} from './review-project-identity'
const project = { host: 'gitlab.com', path: 'g/p' }
const result = (id: number) => ({
  stdout: JSON.stringify({ id, path_with_namespace: 'canonical/p' })
})
beforeEach(() => {
  resetReviewProjectIdentitiesForTest()
  read.mockReset()
  signature.mockReset().mockResolvedValue('config-1')
})
it('coalesces minimal identities, invalidates changed configuration, and does not retain failed reads', async () => {
  read.mockResolvedValue(result(1))
  await expect(
    Promise.all([
      readReviewProjectIdentity('/repo', project, null, {}),
      readReviewProjectIdentity('/repo', project, null, {})
    ])
  ).resolves.toEqual([
    { id: 1, path: 'canonical/p' },
    { id: 1, path: 'canonical/p' }
  ])
  expect(read).toHaveBeenCalledTimes(1)
  signature.mockResolvedValue('config-2')
  read.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(result(2))
  await expect(readReviewProjectIdentity('/repo', project, null, {})).rejects.toThrow('offline')
  await expect(readReviewProjectIdentity('/repo', project, null, {})).resolves.toMatchObject({
    id: 2
  })
  expect(read).toHaveBeenCalledTimes(3)
})
it('does not let an older forced-out read overwrite its successor', async () => {
  let finish: (value: { stdout: string }) => void = () => {
    throw new Error('not started')
  }
  let started: () => void = () => {
    throw new Error('not started')
  }
  const admitted = new Promise<void>((resolve) => {
    started = resolve
  })
  read
    .mockImplementationOnce(() => {
      started()
      return new Promise<{ stdout: string }>((resolve) => {
        finish = resolve
      })
    })
    .mockResolvedValueOnce(result(2))
  const old = readReviewProjectIdentity('/repo', project, null, {})
  await admitted
  await expect(readReviewProjectIdentity('/repo', project, null, {}, true)).resolves.toMatchObject({
    id: 2
  })
  finish(result(1))
  await old
  await expect(readReviewProjectIdentity('/repo', project, null, {})).resolves.toMatchObject({
    id: 2
  })
  expect(read).toHaveBeenCalledTimes(2)
})
