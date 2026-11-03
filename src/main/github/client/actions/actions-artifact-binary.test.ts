import { afterEach, expect, it, vi } from 'vitest'
import * as execution from '../../github-api-repository'
import * as resolution from '../../../git/command-runner/wsl-command-resolution'
import { startActionsArtifactDownload } from './actions-artifacts'
import {
  artifactSessionOwner,
  readArtifactSession,
  releaseArtifactSession
} from './artifact-download-sessions'

// Stored ZIP containing hello.txt, including non-UTF-8 CRC bytes.
const zipBase64 =
  'UEsDBBQAAAAAAAAAIVwCDJr/IwAAACMAAAAJAAAAaGVsbG8udHh0SGVsbG8gZnJvbSB0aGUgT3JjYSBtb2NrIGFydGlmYWN0LgpQSwECFAMUAAAAAAAAACFcAgya/yMAAAAjAAAACQAAAAAAAAAAAAAAgAEAAAAAaGVsbG8udHh0UEsFBgAAAAABAAEANwAAAEoAAAAAAA=='
const origin = { owner: 'acme', repo: 'widgets', host: 'github.com' }

afterEach(() => vi.restoreAllMocks())

it('downloads exact ZIP bytes through the real gh subprocess capture and chunk path', async () => {
  vi.spyOn(execution, 'getGitHubApiRepositoryForRemote').mockResolvedValue(origin)
  const metadata = {
    id: 7,
    name: 'hello',
    size_in_bytes: 161,
    expired: false,
    workflow_run: { id: 9 }
  }
  const script = `process.stdout.write(process.argv.at(-1).endsWith('/zip') ? Buffer.from(${JSON.stringify(zipBase64)}, 'base64') : ${JSON.stringify(JSON.stringify(metadata))})`
  vi.spyOn(resolution, 'resolveCommand').mockImplementation((_command, args) => ({
    binary: process.execPath,
    args: ['-e', script, '--', ...args],
    cwd: undefined,
    wsl: null,
    wslMode: null
  }))
  const transfer = await startActionsArtifactDownload('/repo', {
    repository: origin,
    runId: 9,
    artifactId: 7
  })
  const owner = artifactSessionOwner('/repo')
  try {
    expect(
      Buffer.from(readArtifactSession(transfer.transferId, owner, 0).contentBase64, 'base64')
    ).toEqual(Buffer.from(zipBase64, 'base64'))
  } finally {
    releaseArtifactSession(transfer.transferId, owner)
  }
})
