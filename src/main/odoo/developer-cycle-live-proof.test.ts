/**
 * Developer-cycle proof against a real Odoo server: ticket selection, worktree
 * linkage, a real commit, and an @mention that reaches the parent ticket's
 * responsible.
 *
 * `live-proof.test.ts` proves the individual transport round trips. This proves
 * the cycle around them, driving the shipped decision modules rather than
 * restating their rules: the auto-workspace criteria, `addWorktree`, the
 * `worktree.set` metadata schema, and the mention markup builder.
 *
 * The board-status → `stage_id` half of the cycle lives next to the hook it
 * drives, in
 * `src/renderer/src/components/sidebar/workspace-status-odoo-stage-write-live-proof.test.ts`,
 * because that one needs a DOM the main-process TypeScript project does not load.
 *
 * Opt-in and credential-free: set ODOO_PROOF_URL / _DB / _LOGIN / _KEY against a
 * disposable instance. Unset, the suite skips so CI stays green.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { connect, getClients } from './client'
import { executeKw, type OdooClientForInstance } from './json-rpc'
import { installOdooLiveProofHostPorts } from './live-proof-host-ports'
import { addTicketComment, searchMentionCandidates } from './ticket-chatter'
import { getTicket, listStages } from './tickets'
import { addWorktree } from '../git/worktree'
import { getLinkedWorkItemMetadata } from '../ipc/worktree-linked-work-item-metadata'
import { WorktreeSet } from '../runtime/rpc/methods/worktree-schemas'
import {
  DEFAULT_ODOO_AUTO_WORKSPACE_CRITERIA,
  matchesOdooAutoWorkspaceCriteria,
  selectOdooAutoWorkspaceCandidates
} from '../../renderer/src/components/odoo-auto-workspace-criteria'
import { resolveOdooMentionMarkup } from '../../renderer/src/components/odoo-comment-mention-query'
import { WORKTREE_ID_SEPARATOR } from '../../shared/worktree/id'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'

const CHILD_TICKET_ID = Number(process.env.ODOO_PROOF_CHILD_TICKET ?? '80')
const PARENT_TICKET_ID = Number(process.env.ODOO_PROOF_PARENT_TICKET ?? '79')
const UNASSIGNED_TICKET_ID = Number(process.env.ODOO_PROOF_UNASSIGNED_TICKET ?? '75')
const PROJECT_ID = Number(process.env.ODOO_PROOF_PROJECT ?? '7')
const RUN = `cycle-${Date.now()}`
const REPO_ID = 'odoo-proof-repo'
const BRANCH = `odoo/${CHILD_TICKET_ID}-empty-password`

const LIVE = Boolean(process.env.ODOO_PROOF_URL)

let viewerUid: number | undefined
let instanceId = ''
let client: OdooClientForInstance
let repoPath = ''
let worktreePath = ''
let worktreeId = ''
let scratchRoot = ''

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

describe.skipIf(!LIVE)('Odoo developer cycle', () => {
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
    if (result.ok) {
      viewerUid = result.viewer.uid
    }
    const clients = getClients()
    expect(clients.length).toBeGreaterThan(0)
    client = clients[0]
    instanceId = client.instance.id
  }, 90_000)

  afterAll(() => {
    if (scratchRoot) {
      rmSync(scratchRoot, { recursive: true, force: true })
    }
  })

  it('step 1 — the auto-workspace criteria select the assigned ticket and reject the rest', async () => {
    const assigned = await getTicket(CHILD_TICKET_ID)
    const unassigned = await getTicket(UNASSIGNED_TICKET_ID)
    expect(assigned, 'child ticket not readable').not.toBeNull()
    expect(unassigned, 'control ticket not readable').not.toBeNull()
    if (!assigned || !unassigned) {
      return
    }
    const currentStageId = assigned.stage?.id
    expect(currentStageId, 'child ticket has no stage').toBeDefined()
    const stages = await listStages(PROJECT_ID)
    const otherStage = stages.find((stage) => stage.id !== currentStageId)
    expect(otherStage, 'project needs a second stage for the negative case').toBeDefined()
    if (currentStageId === undefined || !otherStage) {
      return
    }

    const criteria = {
      ...DEFAULT_ODOO_AUTO_WORKSPACE_CRITERIA,
      assignedToMe: true,
      stageIds: [currentStageId]
    }
    const context = { viewerUid, now: Date.now() }

    expect(matchesOdooAutoWorkspaceCriteria(assigned, criteria, context)).toBe(true)
    // The control ticket sits in the same project and stage and also has a
    // description; only the assignee differs, so a pass here would mean the
    // rule matches everything.
    expect(matchesOdooAutoWorkspaceCriteria(unassigned, criteria, context)).toBe(false)
    // The stage clause has to bite too, or "assigned to me, any stage" would be
    // the rule actually under test.
    expect(
      matchesOdooAutoWorkspaceCriteria(
        assigned,
        { ...criteria, stageIds: [otherStage.id] },
        context
      )
    ).toBe(false)
    // And an unknown viewer must refuse rather than widen to every assignee.
    expect(
      matchesOdooAutoWorkspaceCriteria(assigned, criteria, {
        viewerUid: undefined,
        now: Date.now()
      })
    ).toBe(false)

    const selection = selectOdooAutoWorkspaceCandidates([unassigned, assigned], criteria, {
      ...context,
      excludedTicketIds: new Set<number>(),
      maxPerRun: 5
    })
    expect(selection.selected.map((ticket) => ticket.id)).toEqual([CHILD_TICKET_ID])
    console.log(
      'STEP1 PROOF',
      JSON.stringify({
        viewerUid,
        criteriaStageIds: criteria.stageIds,
        selected: selection.selected.map((ticket) => ({
          id: ticket.id,
          stage: ticket.stage,
          assignees: ticket.assignees.map((user) => user.id)
        })),
        rejected: {
          id: unassigned.id,
          stage: unassigned.stage?.name,
          assignees: unassigned.assignees.map((user) => user.id)
        }
      })
    )
  }, 90_000)

  it('step 2 — a real git worktree carries the Odoo link in the product metadata shape', async () => {
    scratchRoot = mkdtempSync(join(tmpdir(), 'orca-odoo-cycle-'))
    repoPath = join(scratchRoot, 'repo')
    worktreePath = join(scratchRoot, `ticket-${CHILD_TICKET_ID}`)
    execFileSync('git', ['init', '--quiet', repoPath])
    git(repoPath, ['config', 'user.email', 'proof@example.com'])
    git(repoPath, ['config', 'user.name', 'Odoo Proof'])
    writeFileSync(
      join(repoPath, 'login.js'),
      'export function submit(password) {\n  return password.length\n}\n'
    )
    git(repoPath, ['add', '.'])
    git(repoPath, ['commit', '--quiet', '-m', 'seed'])
    const baseBranch = git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])

    await addWorktree(repoPath, worktreePath, BRANCH, baseBranch)
    worktreeId = `${REPO_ID}${WORKTREE_ID_SEPARATOR}${worktreePath}`

    // The worktree is really registered with git, not just a directory.
    expect(git(repoPath, ['worktree', 'list', '--porcelain'])).toContain(worktreePath)
    expect(git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(BRANCH)

    const ticket = await getTicket(CHILD_TICKET_ID)
    const meta: WorktreeMeta = {
      displayName: `#${CHILD_TICKET_ID} ${ticket?.title ?? ''}`.trim(),
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      linkedOdooTicket: CHILD_TICKET_ID,
      linkedOdooInstanceId: instanceId,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: Date.now()
    }

    // The runtime schema is the product's only runtime gate on this pair; parse
    // the link exactly the way `worktree.set` does over RPC.
    const parsed = WorktreeSet.safeParse({
      worktree: worktreeId,
      linkedOdooTicket: meta.linkedOdooTicket,
      linkedOdooInstanceId: meta.linkedOdooInstanceId
    })
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true)
    expect(parsed.success && parsed.data.linkedOdooTicket).toBe(CHILD_TICKET_ID)
    expect(parsed.success && parsed.data.linkedOdooInstanceId).toBe(instanceId)
    // A wrong shape has to fail, or the schema check proves nothing.
    expect(
      WorktreeSet.safeParse({ worktree: worktreeId, linkedOdooTicket: String(CHILD_TICKET_ID) })
        .success
    ).toBe(false)

    const linked = getLinkedWorkItemMetadata(meta)
    expect(linked.linkedOdooTicket).toBe(CHILD_TICKET_ID)
    expect(linked.linkedOdooInstanceId).toBe(instanceId)
    console.log(
      'STEP2 PROOF',
      JSON.stringify({
        worktreePath,
        branch: BRANCH,
        worktreeId,
        linked,
        ticketTitle: ticket?.title
      })
    )
  }, 90_000)

  it('step 3 — a real commit lands in that worktree', () => {
    writeFileSync(
      join(worktreePath, 'login.js'),
      'export function submit(password) {\n  if (!password) {\n    return 0\n  }\n  return password.length\n}\n'
    )
    git(worktreePath, ['add', 'login.js'])
    git(worktreePath, [
      'commit',
      '--quiet',
      '-m',
      `fix(login): guard empty password (#${CHILD_TICKET_ID})`
    ])

    const head = git(worktreePath, ['rev-parse', 'HEAD'])
    const subject = git(worktreePath, ['log', '-1', '--pretty=%s'])
    const changed = git(worktreePath, ['show', '--name-only', '--pretty=format:', 'HEAD'])
    expect(subject).toContain(`#${CHILD_TICKET_ID}`)
    expect(changed).toContain('login.js')
    expect(git(worktreePath, ['status', '--porcelain'])).toBe('')
    console.log('STEP3 PROOF', JSON.stringify({ head, subject, changed }))
  })

  it("step 5 — a chatter message mentions the parent's responsible as a real recipient", async () => {
    const parent = await getTicket(PARENT_TICKET_ID)
    expect(parent, 'parent ticket not readable').not.toBeNull()
    const responsible = parent?.assignees[0]
    expect(responsible, 'parent ticket has no responsible to mention').toBeDefined()
    if (!responsible) {
      return
    }

    // Resolve the res.partner behind that user through the shipped mention
    // search instead of hardcoding an id.
    const candidates = await searchMentionCandidates(CHILD_TICKET_ID, responsible.displayName)
    const target = candidates.find((candidate) => candidate.name.includes(responsible.displayName))
    expect(target, `no mention candidate for ${responsible.displayName}`).toBeDefined()
    if (!target) {
      return
    }

    const draft = `Blocked on the parent — @${target.name} can you confirm? ${RUN}`
    const { body, partnerIds } = resolveOdooMentionMarkup(draft, [
      { id: target.id, name: target.name }
    ])
    expect(partnerIds).toEqual([target.id])

    const posted = await addTicketComment(CHILD_TICKET_ID, body, false, undefined, partnerIds)
    expect(posted.ok, posted.ok ? '' : posted.error).toBe(true)

    const messages = await executeKw<Record<string, unknown>[]>(
      client,
      'mail.message',
      'search_read',
      [
        [
          ['model', '=', 'project.task'],
          ['res_id', '=', CHILD_TICKET_ID],
          ['body', 'like', RUN]
        ]
      ],
      { fields: ['id', 'body', 'partner_ids', 'author_id'] }
    )
    expect(messages.length, 'posted message not found on the server').toBe(1)
    const message = messages[0]
    expect(String(message.body)).toContain(`data-oe-id="${target.id}"`)
    expect(String(message.body)).toContain('data-oe-model="res.partner"')
    // A mention that only looks right in the body is not a mention: the partner
    // has to be a recipient on the record.
    expect(message.partner_ids as number[]).toContain(target.id)
    console.log(
      'STEP5 PROOF',
      JSON.stringify({
        parentResponsible: { userId: responsible.id, name: responsible.displayName },
        partner: { id: target.id, name: target.name },
        messageId: message.id,
        partnerIds: message.partner_ids,
        body: message.body
      })
    )
  }, 120_000)

  it('step 6 — a timesheet line is logged outside the product, which has no timesheet feature', async () => {
    // Orca ships no timesheet surface (`account.analytic.line` appears nowhere
    // in the codebase), so this rides the raw JSON-RPC transport only.
    const fields = await executeKw<Record<string, { type: string }>>(
      client,
      'account.analytic.line',
      'fields_get',
      [],
      { attributes: ['type'] }
    )
    // Without hr_timesheet the model has no task link at all; record which shape
    // the server offered instead of silently logging an unattached line.
    const hasTaskLink = Object.keys(fields).includes('task_id')

    const values: Record<string, unknown> = {
      name: `Orca proof ${RUN} — task #${CHILD_TICKET_ID}`,
      date: new Date().toISOString().slice(0, 10),
      unit_amount: 1.5,
      user_id: viewerUid
    }
    if (hasTaskLink) {
      values.task_id = CHILD_TICKET_ID
      values.project_id = PROJECT_ID
    }
    const id = await executeKw<number>(client, 'account.analytic.line', 'create', [values])
    expect(id).toBeGreaterThan(0)

    const rows = await executeKw<Record<string, unknown>[]>(
      client,
      'account.analytic.line',
      'read',
      [[id]],
      {
        fields: hasTaskLink
          ? ['name', 'unit_amount', 'date', 'task_id']
          : ['name', 'unit_amount', 'date']
      }
    )
    expect(rows[0]?.unit_amount).toBe(1.5)
    expect(String(rows[0]?.name)).toContain(`#${CHILD_TICKET_ID}`)
    if (hasTaskLink) {
      const taskRef = rows[0]?.task_id as [number, string] | undefined
      expect(taskRef?.[0]).toBe(CHILD_TICKET_ID)
    }
    console.log('STEP6 PROOF', JSON.stringify({ hasTaskLink, id, row: rows[0] }))
  }, 90_000)
})
