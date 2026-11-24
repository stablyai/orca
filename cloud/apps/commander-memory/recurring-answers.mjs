import { randomUUID } from 'node:crypto'

const decisionPrefix = 'preference-decision-'

function literal(value, limit) {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= limit && value.trim() === value
  )
}

export function readRule(body) {
  let rule
  try {
    rule = JSON.parse(body)
  } catch {
    return null
  }
  return rule?.version === 1 &&
    Object.keys(rule).length === 3 &&
    literal(rule.question, 500) &&
    literal(rule.answer, 2000)
    ? rule
    : null
}

function quoteLines(value) {
  return value
    .split(/\r\n|[\n\r]/)
    .map((line) => '    ' + line)
    .join('\n')
}

export function openRecurringAnswers(db, { fail, validId }) {
  db.exec(`CREATE TABLE IF NOT EXISTS preference_requests (
    tenant TEXT NOT NULL, actor TEXT NOT NULL, project TEXT NOT NULL, request TEXT NOT NULL,
    question TEXT NOT NULL, response TEXT NOT NULL, decision_page TEXT,
    PRIMARY KEY(tenant, actor, project, request), UNIQUE(tenant, decision_page)
  );
  CREATE TABLE IF NOT EXISTS preference_settings (
    tenant TEXT PRIMARY KEY, enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
    version INTEGER NOT NULL CHECK(version > 0)
  );
  CREATE INDEX IF NOT EXISTS recurring_answer_candidates
    ON revisions(tenant, json_extract(data, '$.projectId'), page, version DESC)
    WHERE json_extract(data, '$.kind')='guideline'
      AND json_extract(data, '$.title')='Recurring answer'
      AND json_extract(data, '$.deleted')=0
      AND json_extract(data, '$.createdBy.type')='human'
      AND json_extract(data, '$.actor.type')='human';`)
  const rules = db.prepare(`SELECT r.data FROM revisions r
    WHERE r.tenant=? AND json_extract(r.data, '$.projectId')=?
      AND json_extract(r.data, '$.kind')='guideline'
      AND json_extract(r.data, '$.title')='Recurring answer'
      AND json_extract(r.data, '$.deleted')=0
      AND json_extract(r.data, '$.createdBy.type')='human'
      AND json_extract(r.data, '$.actor.type')='human'
      AND NOT EXISTS (SELECT 1 FROM revisions newer
        WHERE newer.tenant=r.tenant AND newer.page=r.page AND newer.version>r.version)`)
  const previous = db.prepare(`SELECT question,response FROM preference_requests
    WHERE tenant=? AND actor=? AND project=? AND request=?`)
  const save = db.prepare(`INSERT INTO preference_requests
    (tenant, actor, project, request, question, response, decision_page) VALUES (?, ?, ?, ?, ?, ?, ?)`)
  const audited = db.prepare('SELECT 1 FROM preference_requests WHERE tenant=? AND decision_page=?')
  const pageExists = db.prepare('SELECT 1 FROM revisions WHERE tenant=? AND page=? LIMIT 1')
  const append = db.prepare('INSERT INTO revisions VALUES (?, ?, ?, ?, ?, ?, ?)')
  const readSettings = db.prepare('SELECT enabled,version FROM preference_settings WHERE tenant=?')
  const saveSettings = db.prepare(`INSERT INTO preference_settings (tenant,enabled,version)
    VALUES (?,?,?) ON CONFLICT(tenant) DO UPDATE SET enabled=excluded.enabled, version=excluded.version`)

  function currentSettings(tenant) {
    const row = readSettings.get(tenant)
    return { enabled: row?.enabled === 1, version: row?.version ?? 0 }
  }

  function transaction(operation) {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  function resolve(identity, question, requestId) {
    const { tenant, actor, projectId } = identity
    let match
    for (const { data } of rules.iterate(tenant, projectId)) {
      const page = JSON.parse(data)
      const rule = readRule(page.body)
      if (rule?.question !== question) continue
      if (match) return { matched: false, reason: 'conflict' }
      match = { answer: rule.answer, rulePageId: page.pageId, ruleVersion: page.version }
    }
    if (!match) return { matched: false, reason: 'missing' }
    let pageId
    do {
      pageId = decisionPrefix + randomUUID()
    } while (pageExists.get(tenant, pageId))
    const page = {
      pageId,
      kind: 'decision',
      recurringAnswerReceipt: true,
      title: 'Applied recurring answer',
      body: [
        'Requested by',
        quoteLines(actor.type + ' ' + actor.id),
        'Human guideline',
        quoteLines(match.rulePageId + ' (revision ' + match.ruleVersion + ')'),
        'Worker question',
        quoteLines(question),
        'Recorded answer',
        quoteLines(match.answer)
      ].join('\n\n'),
      links: [match.rulePageId],
      projectId,
      version: 1,
      deleted: false,
      actor,
      createdBy: actor,
      createdAt: new Date().toISOString(),
      requestId
    }
    // Use a separate SQLite actor key so normal wiki request IDs remain independent.
    const auditKey = JSON.stringify(['preferences/ask', actor.type, actor.id, projectId])
    append.run(tenant, pageId, 1, auditKey, requestId, '', JSON.stringify(page))
    return { matched: true, ...match, decisionPageId: pageId }
  }
  return {
    settings({ tenant, actor }, update) {
      if (actor.type !== 'human') fail(403, 'Only the account can access preference settings')
      if (update === undefined) return currentSettings(tenant)
      const { enabled, expectedVersion } = update
      if (
        Object.keys(update).length !== 2 ||
        typeof enabled !== 'boolean' ||
        !Number.isSafeInteger(expectedVersion) ||
        expectedVersion < 0
      )
        fail(400, 'Invalid recurring answer settings')
      return transaction(() => {
        const current = currentSettings(tenant)
        if (
          expectedVersion > current.version ||
          (expectedVersion !== current.version && enabled !== current.enabled)
        )
          fail(409, 'Recurring answer settings changed; reload to continue')
        if (enabled === current.enabled) return current
        const version = current.version + 1
        saveSettings.run(tenant, Number(enabled), version)
        return { enabled, version }
      })
    },
    reserved(tenant, pageId, exists) {
      return pageId.startsWith(decisionPrefix) && (!exists || !!audited.get(tenant, pageId))
    },
    ask(identity, payload) {
      const { tenant, actor, projectId } = identity
      if (!['agent', 'commander'].includes(actor.type) || !projectId)
        fail(403, 'A project-scoped delegation is required')
      const { question, requestId } = payload
      if (
        Object.keys(payload).some(
          (key) =>
            !['question', 'requestId', 'expectedProjectId', 'expectedActorType'].includes(key)
        ) ||
        !validId(requestId) ||
        !literal(question, 500)
      )
        fail(400, 'Invalid preference question or request ID')
      if (Object.hasOwn(payload, 'expectedProjectId') && payload.expectedProjectId !== projectId)
        fail(403, 'Delegation does not match the expected project')
      if (Object.hasOwn(payload, 'expectedActorType') && payload.expectedActorType !== actor.type)
        fail(403, 'Delegation does not match the expected role')
      const scope = [tenant, JSON.stringify([actor.type, actor.id]), projectId, requestId]
      const serializedQuestion = JSON.stringify(question)
      return transaction(() => {
        if (!currentSettings(tenant).enabled) return { matched: false, reason: 'disabled' }
        const replay = previous.get(...scope)
        if (replay && replay.question !== serializedQuestion)
          fail(409, 'Request ID already used for another question')
        const response = replay
          ? JSON.parse(replay.response)
          : resolve(identity, question, requestId)
        if (!replay)
          save.run(
            ...scope,
            serializedQuestion,
            JSON.stringify(response),
            response.decisionPageId ?? null
          )
        return response
      })
    }
  }
}
