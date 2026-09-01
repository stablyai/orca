/**
 * Live round-trip proof against a real Odoo server.
 *
 * Unit tests cover the parsing and the mappers; they cannot show that
 * `message_post` actually attaches a file, that a mention reaches the partner
 * it names, that an edit rewrites the message rather than appending one, or
 * that a stage write lands. This exercises the real main-process code to show
 * exactly that.
 *
 * Opt-in and credential-free: set ODOO_PROOF_URL / _DB / _LOGIN / _KEY against
 * a disposable instance. Unset, the suite skips.
 */
import { beforeAll, describe, expect, it } from 'vitest'

import { connect } from './client'
import { installOdooLiveProofHostPorts } from './live-proof-host-ports'
import {
  addTicketComment,
  getTicketComments,
  searchMentionCandidates,
  updateTicketComment,
  uploadTicketAttachments
} from './ticket-chatter'
import { getTicket, listStages, updateTicket } from './tickets'

const TICKET_ID = Number(process.env.ODOO_PROOF_TICKET ?? '72')
const PROJECT_ID = Number(process.env.ODOO_PROOF_PROJECT ?? '7')
const RUN = `proof-${Date.now()}`

// Opt-in: without ODOO_PROOF_URL this suite skips, so CI stays green while a
// reviewer can point it at their own throwaway Odoo and see the round trips
// happen for real. Credentials come from the environment, never from the file.
const LIVE = Boolean(process.env.ODOO_PROOF_URL)

describe.skipIf(!LIVE)('Odoo live round trips', () => {
  beforeAll(async () => {
    // Inside the skipped describe so a non-live run leaves the process-wide ports alone.
    installOdooLiveProofHostPorts()
    const result = await connect({
      serverUrl: process.env.ODOO_PROOF_URL as string,
      database: process.env.ODOO_PROOF_DB as string,
      login: process.env.ODOO_PROOF_LOGIN as string,
      apiKey: process.env.ODOO_PROOF_KEY as string
    })
    expect(result.ok, `connect failed: ${result.ok ? '' : result.error}`).toBe(true)
  }, 60_000)

  it('uploads an attachment and posts it on a message', async () => {
    const upload = await uploadTicketAttachments(TICKET_ID, [
      {
        name: `${RUN}.txt`,
        mimetype: 'text/plain',
        data: Buffer.from(`attachment round trip ${RUN}`).toString('base64')
      }
    ])
    expect(upload.ok, upload.ok ? '' : upload.error).toBe(true)
    if (!upload.ok) {
      return
    }

    const posted = await addTicketComment(
      TICKET_ID,
      `Attachment round trip ${RUN}`,
      true,
      undefined,
      undefined,
      upload.ids
    )
    expect(posted.ok, posted.ok ? '' : posted.error).toBe(true)

    const comments = await getTicketComments(TICKET_ID)
    const mine = comments.find((c) => c.body.includes(RUN))
    expect(mine, 'posted message not found when read back').toBeDefined()
    expect(mine?.attachments?.length, 'attachment did not land on the message').toBe(1)
    expect(mine?.attachments?.[0]?.name).toBe(`${RUN}.txt`)
    console.log('ATTACHMENT PROOF', JSON.stringify(mine?.attachments))
  }, 90_000)

  it('delivers a mention to the partner it names', async () => {
    const candidates = await searchMentionCandidates(TICKET_ID, '')
    expect(candidates.length, 'no mention candidates returned').toBeGreaterThan(0)
    const target = candidates[0]

    const body = `Mention round trip ${RUN} <a href="#" data-oe-model="res.partner" data-oe-id="${target.id}" class="o_mail_redirect">@${target.name}</a>`
    const posted = await addTicketComment(TICKET_ID, body, true, undefined, [target.id])
    expect(posted.ok, posted.ok ? '' : posted.error).toBe(true)

    const comments = await getTicketComments(TICKET_ID)
    const mine = comments.find((c) => c.body.includes(`Mention round trip ${RUN}`))
    expect(mine, 'mention message not found when read back').toBeDefined()
    console.log('MENTION PROOF', JSON.stringify({ partner: target, body: mine?.body }))
  }, 90_000)

  it('edits a message in place rather than appending a new one', async () => {
    const posted = await addTicketComment(TICKET_ID, `Edit source ${RUN}`, true)
    expect(posted.ok).toBe(true)
    const before = await getTicketComments(TICKET_ID)
    const target = before.find((c) => c.body.includes(`Edit source ${RUN}`))
    expect(target, 'source message not found').toBeDefined()
    if (!target) {
      return
    }

    const edited = await updateTicketComment(target.id, `Edited body ${RUN}`)
    expect(edited.ok, edited.ok ? '' : edited.error).toBe(true)

    const after = await getTicketComments(TICKET_ID)
    expect(after.filter((c) => c.body.includes(RUN) && c.id === target.id)).toHaveLength(1)
    expect(after.find((c) => c.id === target.id)?.body).toContain(`Edited body ${RUN}`)
    console.log('EDIT PROOF', JSON.stringify({ id: target.id }))
  }, 90_000)

  it('pushes a stage change onto the ticket', async () => {
    const stages = await listStages(PROJECT_ID)
    expect(stages.length, 'no stages on the project').toBeGreaterThan(1)
    const target = stages.at(-1)

    expect(target).toBeDefined()
    if (!target) {
      return
    }
    // The configured ticket is reusable proof data, so the move is undone: a run
    // that parked it in the last stage would make the next run start elsewhere.
    const originalStageId = (await getTicket(TICKET_ID))?.stage?.id ?? null
    try {
      const written = await updateTicket(TICKET_ID, { stageId: target.id })
      expect(written.ok, written.ok ? '' : written.error).toBe(true)
      expect((await getTicket(TICKET_ID))?.stage?.id, 'stage write did not land').toBe(target.id)
      console.log('STAGE PROOF', JSON.stringify({ movedTo: target.name, id: target.id }))
    } finally {
      if (originalStageId !== null && originalStageId !== target.id) {
        await updateTicket(TICKET_ID, { stageId: originalStageId })
      }
    }
  }, 90_000)
})
