import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'

const mocks = vi.hoisted(() => ({ upload: vi.fn() }))

vi.mock('electron', () => ({ app: { getPath: () => '/user-data' } }))
vi.mock('../../ipc/agent-session-attachment-upload', () => ({
  uploadPasteToAgentSessionAttachments: mocks.upload
}))

import { savePastedTextAsFile } from './native-chat-pasted-text-file'
import { AgentSessionAttachmentStore } from '../../native-chat/agent-session-attachments/agent-session-attachment-store'

describe('a long paste saved as a file', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'orca-pasted-text-'))
    installFakeAppEnvironment({ getPath: () => root })
    mocks.upload.mockReset()
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('writes UTF-8 through the ordinary unclaimed store', async () => {
    const store = new AgentSessionAttachmentStore(path.join(root, 'agent-session-attachments'), {
      hasSession: () => true
    })
    const saved = await savePastedTextAsFile({ text: 'log line ✓\n' }, async () => store)
    expect(path.dirname(path.dirname(saved))).toBe(store.rootDir)
    expect(readFileSync(saved, 'utf8')).toBe('log line ✓\n')
  })
})
