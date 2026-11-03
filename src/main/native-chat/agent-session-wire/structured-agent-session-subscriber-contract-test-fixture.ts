import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach } from 'vitest'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'

export const SESSION = 'subscriber-session'

let root: string

export const journals = createTrackedJournalOpener({ legacyInputs: true })

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-agent-subscribers-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

export const fixture = {
  get root() {
    return root
  },
  set root(value: typeof root) {
    root = value
  }
}
