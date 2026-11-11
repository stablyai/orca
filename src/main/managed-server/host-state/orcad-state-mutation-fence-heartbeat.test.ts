// Exercise real heartbeats and steal commands so long mutations retain activation ownership.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import { RELAY_INSTALL_LOCK_NAME } from '../../../shared/relay-install-lock-name'
import { ORCAD_ACTIVATION_TRANSACTION_DIRNAME } from '../activation/orcad-activation-transaction'
import { serializedStateMutationCommand } from './orcad-state-snapshot'
import { ORCAD_FENCE_OWNER_FILENAME } from '../activation/orcad-activation-fence-scope'
const HEARTBEAT_SECONDS = 0.1

async function sh(command: string): Promise<string> {
  return (await runProcess({ program: '/bin/sh', args: ['-c', command] })).stdout.trim()
}

describe.skipIf(process.platform === 'win32')(
  'the fence heartbeat of a running state mutation',
  () => {
    let base = ''
    let fence = ''

    beforeEach(async () => {
      base = mkdtempSync(join(tmpdir(), 'orcad-fence-beat-'))
      fence = join(base, ORCAD_ACTIVATION_TRANSACTION_DIRNAME, RELAY_INSTALL_LOCK_NAME)
      mkdirSync(fence, { recursive: true })
      writeFileSync(join(fence, ORCAD_FENCE_OWNER_FILENAME), 'holder-1')
    })
    const mutation = (script: string): string =>
      serializedStateMutationCommand(base, script, HEARTBEAT_SECONDS, {
        lockDir: fence,
        token: 'holder-1'
      })
    afterEach(() => {
      rmSync(base, { recursive: true, force: true })
    })

    it('never starts a mutation once its run no longer owns the fence', async () => {
      writeFileSync(join(fence, ORCAD_FENCE_OWNER_FILENAME), 'successor')
      const marker = join(base, 'mutated')
      expect(await sh(mutation(`touch '${marker}'`))).toBe('__ORCAD_FENCE_LOST__')
      expect(existsSync(marker)).toBe(false)
      expect(existsSync(join(base, 'orcad-state-mutation.lock'))).toBe(false)
    }, 20_000)
  }
)
