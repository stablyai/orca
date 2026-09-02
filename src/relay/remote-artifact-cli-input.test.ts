import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ARTIFACT_CLI_MAX_RPC_BYTES } from '../shared/artifacts'
import { prepareRemoteArtifactCliInput } from './remote-artifact-cli-input'
import { DISPATCHER_CONTROL_QUEUE_MAX_BYTES } from './dispatcher-writer-admission'
import {
  assertRemoteArtifactCliForwardingFits,
  remoteArtifactCliForwardingFrameBytes,
  type RemoteArtifactCliForwardingParams
} from './remote-artifact-cli-forwarding'

const createdPaths: string[] = []

async function remoteFolder(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'orca-remote-artifact-'))
  createdPaths.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(
    createdPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe('prepareRemoteArtifactCliInput', () => {
  it('reads a folder-workspace file on the SSH host and preserves its source path', async () => {
    const cwd = await remoteFolder()
    await writeFile(join(cwd, 'report.md'), '# Remote report', 'utf8')

    await expect(
      prepareRemoteArtifactCliInput(['artifacts', 'share', 'report.md'], cwd)
    ).resolves.toEqual({
      stdin: '# Remote report',
      artifactInput: {
        sourceKey: join(cwd, 'report.md'),
        fileName: 'report.md',
        contentType: 'text/markdown'
      }
    })
  })

  it('rejects a sparse oversized file from stat metadata before reading its contents', async () => {
    const cwd = await remoteFolder()
    const path = join(cwd, 'sparse.html')
    const handle = await open(path, 'w')
    await handle.truncate(ARTIFACT_CLI_MAX_RPC_BYTES + 1)
    await handle.close()

    await expect(
      prepareRemoteArtifactCliInput(['artifacts', 'share', 'sparse.html'], cwd)
    ).rejects.toThrow(/too large/)
  })

  it('transfers source identity without reading content for unshare', async () => {
    const cwd = await remoteFolder()

    await expect(
      prepareRemoteArtifactCliInput(['artifacts', 'unshare', 'missing.html'], cwd)
    ).resolves.toEqual({
      artifactInput: { sourceKey: join(cwd, 'missing.html'), fileName: 'missing.html' }
    })
  })
})

function forwardingParams(stdin: string): RemoteArtifactCliForwardingParams {
  return {
    argv: ['artifacts', 'share', 'report.md'],
    cwd: '/workspace',
    env: { ORCA_WORKSPACE_ID: 'workspace-1' },
    stdin,
    artifactInput: {
      sourceKey: '/workspace/report.md',
      fileName: 'report.md',
      contentType: 'text/markdown'
    }
  }
}

describe('remote artifact CLI forwarding admission', () => {
  it.each([
    ['backslash', '\\'],
    ['quote', '"']
  ])('uses the complete control frame for the %s escape boundary', (_label, character) => {
    const emptyBytes = remoteArtifactCliForwardingFrameBytes(forwardingParams(''))
    const escapedCharacterBytes = Buffer.byteLength(JSON.stringify(character), 'utf8') - 2
    const fittingCharacters = Math.floor(
      (DISPATCHER_CONTROL_QUEUE_MAX_BYTES - emptyBytes) / escapedCharacterBytes
    )
    const fitting = forwardingParams(character.repeat(fittingCharacters))
    const oversized = forwardingParams(character.repeat(fittingCharacters + 1))

    expect(remoteArtifactCliForwardingFrameBytes(fitting)).toBeLessThanOrEqual(
      DISPATCHER_CONTROL_QUEUE_MAX_BYTES
    )
    expect(remoteArtifactCliForwardingFrameBytes(oversized)).toBeGreaterThan(
      DISPATCHER_CONTROL_QUEUE_MAX_BYTES
    )
    expect(() => assertRemoteArtifactCliForwardingFits(fitting)).not.toThrow()
    expect(() => assertRemoteArtifactCliForwardingFits(oversized)).toThrow(
      /too large for the Orca SSH transport/
    )
  })

  it.each([600 * 1024, ARTIFACT_CLI_MAX_RPC_BYTES])(
    'keeps an ordinary %i-byte artifact inside the control budget',
    (bytes) => {
      const params = forwardingParams('a'.repeat(bytes))

      expect(remoteArtifactCliForwardingFrameBytes(params)).toBeLessThanOrEqual(
        DISPATCHER_CONTROL_QUEUE_MAX_BYTES
      )
      expect(() => assertRemoteArtifactCliForwardingFits(params)).not.toThrow()
    }
  )

  it('rejects an escaped artifact that is below the raw file limit', () => {
    const params = forwardingParams('\\'.repeat(600 * 1024))

    expect(Buffer.byteLength(params.stdin ?? '', 'utf8')).toBeLessThan(ARTIFACT_CLI_MAX_RPC_BYTES)
    expect(() => assertRemoteArtifactCliForwardingFits(params)).toThrow(
      /too large for the Orca SSH transport/
    )
  })
})
