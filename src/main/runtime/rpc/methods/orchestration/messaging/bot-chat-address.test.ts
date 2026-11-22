import { expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../../orca-runtime'

vi.mock('./bot-request-send', () => ({ mayReachBot: () => true, sendToBot: async () => null }))
vi.mock(import('./bot-item-mail-files'), async (importOriginal) => ({
  ...(await importOriginal()),
  // The files as admitted into the item's chat: a log in the body, an image apart.
  withItemMailFiles: async <T extends { params: { body?: string } }>(
    _runtime: unknown,
    mail: T
  ) => ({
    ...mail,
    params: { ...mail.params, body: 'Done.\n\n@/srv/orca/agent-session-attachments/u1/run.log' },
    images: ['/srv/orca/agent-session-attachments/u2/after.png']
  })
}))

import { routeBotMail } from './bot-chat-address'

it("carries a send's admitted files in the body when no bot takes it and it goes as ordinary mail", async () => {
  const context = {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: with no --chat or --item to resolve, routing reads nothing from the runtime.
    runtime: {} as OrcaRuntimeService,
    orchestrationCaller: undefined,
    recordMutationReceipt: undefined
  }
  const sender = {
    address: 'term_worker',
    terminalHandle: 'term_worker',
    paneKey: null,
    orcaSessionId: null
  }

  await expect(
    routeBotMail(context, {
      params: { subject: 'Results', body: 'Done.', files: ['/work/run.log', '/work/after.png'] },
      from: 'term_worker',
      to: 'orca_session_id:chat-1',
      sender,
      routing: { run: undefined }
    })
  ).resolves.toEqual({
    to: 'orca_session_id:chat-1',
    body: 'Done.\n\n@/srv/orca/agent-session-attachments/u1/run.log\n\n@/srv/orca/agent-session-attachments/u2/after.png'
  })
})
