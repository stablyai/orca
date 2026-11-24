import { openDispatchPlans } from './dispatch-plans.mjs'
import { openWorkerGuidance } from './worker-guidance.mjs'
import { openPageIndex } from './page-index.mjs'
import { openRecurringAnswers } from './recurring-answers.mjs'
import { createHash, randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

const HISTORY_LIMIT = 25
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/
const digest = (value) => createHash('sha256').update(value).digest('hex')

export function fail(status, message) {
  throw Object.assign(new Error(message), { status })
}

function textValue(value, max) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max
}

function validId(value) {
  return typeof value === 'string' && identifier.test(value)
}

function sameActor(left, right) {
  return left.type === right.type && left.id === right.id
}

function visible(identity, page) {
  return (
    identity.actor.type === 'human' ||
    page.projectId === identity.projectId ||
    (page.projectId === null &&
      page.actor.type === 'human' &&
      ['guideline', 'decision'].includes(page.kind))
  )
}

function validateWrite(payload) {
  const { pageId, requestId, expectedVersion, deleted = false } = payload
  if (
    !validId(pageId) ||
    !validId(requestId) ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 0 ||
    typeof deleted !== 'boolean'
  )
    fail(400, 'Invalid page, request, or version')
  const base = { pageId, requestId, expectedVersion, deleted }
  if (deleted) return base
  const { kind, title, body, projectId = null, links = [] } = payload
  if (
    !['guideline', 'decision', 'note'].includes(kind) ||
    !textValue(title, 240) ||
    typeof body !== 'string' ||
    Buffer.byteLength(body) > 65536 ||
    (projectId !== null && !textValue(projectId, 256)) ||
    !Array.isArray(links) ||
    links.length > 128 ||
    !links.every(validId)
  )
    fail(400, 'Invalid wiki revision')
  return { ...base, kind, title, body, projectId, links: [...new Set(links)] }
}

export function openStore(path) {
  const db = new DatabaseSync(path)
  db.exec(`PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS revisions (
      tenant TEXT NOT NULL, page TEXT NOT NULL, version INTEGER NOT NULL,
      actor TEXT NOT NULL, request TEXT NOT NULL, fingerprint TEXT NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY (tenant, page, version), UNIQUE (tenant, actor, request)
    );
    CREATE INDEX IF NOT EXISTS revision_project_heads
      ON revisions(tenant, json_extract(data, '$.projectId'), page, version DESC);
    CREATE INDEX IF NOT EXISTS revision_global_guidance
      ON revisions(tenant, page, version DESC)
      WHERE json_extract(data, '$.projectId') IS NULL
        AND json_extract(data, '$.actor.type') = 'human'
        AND json_extract(data, '$.kind') IN ('guideline', 'decision');
    CREATE TABLE IF NOT EXISTS delegations (
      token_hash TEXT PRIMARY KEY, tenant TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
      project TEXT NOT NULL, expires INTEGER NOT NULL
    );`)
  const dispatchPlans = openDispatchPlans(db, fail)
  const recurringAnswers = openRecurringAnswers(db, { fail, validId })
  const latest = db.prepare(
    'SELECT data FROM revisions WHERE tenant=? AND page=? ORDER BY version DESC LIMIT 1'
  )
  const history = db.prepare(
    'SELECT data FROM revisions WHERE tenant=? AND page=? AND version<=? ORDER BY version DESC LIMIT ?'
  )
  const list = db.prepare(`SELECT r.data FROM revisions r JOIN
    (SELECT page, MAX(version) AS version FROM revisions WHERE tenant=? GROUP BY page) h
    ON r.page=h.page AND r.version=h.version WHERE r.tenant=? ORDER BY r.page`)
  const scopedList = db.prepare(`WITH heads AS (
    SELECT page, MAX(version) AS version FROM revisions
      WHERE tenant=? AND json_extract(data, '$.projectId')=? GROUP BY page
    UNION ALL
    SELECT page, MAX(version) AS version FROM revisions INDEXED BY revision_global_guidance
      WHERE tenant=? AND json_extract(data, '$.projectId') IS NULL
        AND json_extract(data, '$.actor.type')='human'
        AND json_extract(data, '$.kind') IN ('guideline','decision') GROUP BY page
  )
  SELECT r.data FROM heads CROSS JOIN revisions r
    ON r.tenant=? AND r.page=heads.page AND r.version=heads.version ORDER BY r.page`)
  const previous = db.prepare(
    'SELECT fingerprint,data FROM revisions WHERE tenant=? AND actor=? AND request=?'
  )
  const append = db.prepare('INSERT INTO revisions VALUES (?, ?, ?, ?, ?, ?, ?)')
  return {
    close: () => db.close(),
    index: openPageIndex(db, { fail, validId }),
    workerGuidance: openWorkerGuidance(db, fail),
    replayPlan: dispatchPlans.read,
    askPreference: recurringAnswers.ask,
    preferenceSettings: recurringAnswers.settings,
    delegate(identity, { type, id, projectId }) {
      if (identity.actor.type !== 'human') fail(403, 'Only the account can delegate')
      if (
        !['agent', 'commander'].includes(type) ||
        !textValue(id, 128) ||
        !textValue(projectId, 256)
      )
        fail(400, 'Invalid delegation')
      const token = 'orcacmd_' + randomBytes(32).toString('base64url')
      const expires = Date.now() + 15 * 60_000
      db.prepare('DELETE FROM delegations WHERE expires<=?').run(Date.now())
      db.prepare('INSERT INTO delegations VALUES (?, ?, ?, ?, ?, ?)').run(
        digest(token),
        identity.tenant,
        type,
        id,
        projectId,
        expires
      )
      return { token, expiresAt: new Date(expires).toISOString() }
    },
    delegatedIdentity(token) {
      const row = db
        .prepare('SELECT * FROM delegations WHERE token_hash=? AND expires>?')
        .get(digest(token), Date.now())
      if (!row) fail(401, 'Invalid or expired delegation')
      return { tenant: row.tenant, actor: { type: row.kind, id: row.id }, projectId: row.project }
    },
    list(identity) {
      const { tenant } = identity
      const rows =
        identity.actor.type === 'human'
          ? list.all(tenant, tenant)
          : scopedList.all(tenant, identity.projectId, tenant, tenant)
      return rows.map((row) => JSON.parse(row.data))
    },
    history(identity, pageId, beforeVersion) {
      if (!validId(pageId)) fail(400, 'Invalid page ID')
      if (
        beforeVersion !== undefined &&
        (!Number.isSafeInteger(beforeVersion) || beforeVersion < 1)
      ) {
        fail(400, 'Invalid history cursor')
      }
      const head = latest.get(identity.tenant, pageId)
      const page = head && JSON.parse(head.data)
      if (!page || !visible(identity, page)) fail(404, 'Page not found')
      const ceiling =
        beforeVersion === undefined ? page.version : Math.min(page.version, beforeVersion - 1)
      const rows = history.all(identity.tenant, pageId, ceiling, HISTORY_LIMIT + 1)
      const slice = rows.slice(0, HISTORY_LIMIT).map((row) => JSON.parse(row.data))
      return {
        page,
        history: slice.filter((revision) => visible(identity, revision)),
        nextBeforeVersion: rows.length > HISTORY_LIMIT ? slice.at(-1).version : null
      }
    },
    write(identity, payload) {
      const edit = validateWrite(payload)
      const { tenant, actor } = identity
      const { pageId, requestId, expectedVersion, deleted } = edit
      const actorKey = JSON.stringify([actor.type, actor.id, identity.projectId ?? null])
      const replayPlan =
        payload.replayPlan === undefined
          ? undefined
          : dispatchPlans.validate(identity, edit, payload.replayPlan)
      const fingerprint = digest(JSON.stringify(replayPlan ? { edit, replayPlan } : edit))
      db.exec('BEGIN IMMEDIATE')
      try {
        const replay = previous.get(tenant, actorKey, requestId)
        if (replay) {
          if (replay.fingerprint !== fingerprint)
            fail(409, 'Request ID already used for another edit')
          db.exec('COMMIT')
          return JSON.parse(replay.data)
        }
        const latestRow = latest.get(tenant, pageId)
        const prior = latestRow && JSON.parse(latestRow.data)
        if (prior && !visible(identity, prior)) fail(404, 'Page not found')
        if (recurringAnswers.reserved(tenant, pageId, !!prior))
          fail(403, 'Preference decision pages are managed by Commander Memory')
        if (
          actor.type !== 'human' &&
          ((prior && (!sameActor(actor, prior.createdBy) || !sameActor(actor, prior.actor))) ||
            (!deleted && (edit.projectId !== identity.projectId || edit.kind === 'guideline')))
        )
          fail(403, 'Outside delegated write scope')
        if ((prior?.version ?? 0) !== expectedVersion)
          fail(409, 'Page has changed; read its latest revision')
        if (deleted && !prior) fail(404, 'Page not found')
        if (!deleted && prior && (prior.projectId !== edit.projectId || prior.kind !== edit.kind))
          fail(409, 'Page kind and project are immutable')
        const fields = deleted ? prior : edit
        const page = {
          pageId,
          kind: fields.kind,
          title: fields.title,
          body: fields.body,
          links: fields.links,
          projectId: fields.projectId,
          version: expectedVersion + 1,
          deleted,
          actor,
          createdBy: prior?.createdBy ?? actor,
          createdAt: new Date().toISOString(),
          requestId
        }
        append.run(
          tenant,
          pageId,
          page.version,
          actorKey,
          requestId,
          fingerprint,
          JSON.stringify(page)
        )
        if (replayPlan) dispatchPlans.insert(identity, requestId, replayPlan)
        db.exec('COMMIT')
        return page
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    }
  }
}
