import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ProfileStateSqliteAuthority } from './profile-state-sqlite-authority'
import { ProfileStateRevisionConflictError } from './profile-state-document-validation'

describe('profile export snapshot revision', () => {
  it.each(['json', 'compatibility-sync', 'compatibility-async'] as const)(
    'refuses a competing revision before publishing %s',
    async (kind) => {
      const root = mkdtempSync(join(tmpdir(), 'orca-export-fence-'))
      const database = join(root, 'profile-state.db')
      const target = join(root, 'retained.json')
      const owner = new ProfileStateSqliteAuthority(database, 'export-fence')
      const peer = new ProfileStateSqliteAuthority(database, 'export-fence')
      try {
        owner.writeSerializedState(Buffer.from('{"settings":{"theme":"dark"}}'))
        writeFileSync(target, 'retained export')
        owner.assertCurrentRevision()
        peer.readSerializedState()
        peer.writeSerializedDomains([{ domain: 'settings', payload: '{"theme":"light"}' }])
        await expect(
          Promise.resolve().then(() => {
            if (kind === 'json') {
              return owner.writeJsonExport(target)
            }
            if (kind === 'compatibility-sync') {
              return owner.writeJsonCompatibilityExport(target)
            }
            return owner.writeJsonCompatibilityExportAsync(target)
          })
        ).rejects.toBeInstanceOf(ProfileStateRevisionConflictError)
        expect(readFileSync(target, 'utf8')).toBe('retained export')
        expect(JSON.parse(peer.readSerializedState() ?? '{}').settings.theme).toBe('light')
      } finally {
        owner.close()
        peer.close()
        rmSync(root, { recursive: true, force: true })
      }
    }
  )
})
