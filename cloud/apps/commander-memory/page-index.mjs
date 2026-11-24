import { validHandoffContent } from './handoff-content.mjs'
import { readRule } from './recurring-answers.mjs'

const pageSize = 50
const indexKeys = new Set([
  'order',
  'after',
  'projectId',
  'kind',
  'includeDeleted',
  'includeDeletedProjects',
  'handoffsOnly',
  'recurringOnly',
  'q',
  'id'
])
const hex = '[0-9a-f]'
const handoff = 'handoff-' + [8, 4, 4, 4, 12].map((size) => hex.repeat(size)).join('-')

// Plain SQL in the trigger lets earlier Memory processes keep the index current during a rollout.
function projectHead(source) {
  const data = source + '.data'
  return `${source}.tenant, ${source}.page, ${source}.version,
    json_remove(${data}, '$.body', '$.links', '$.requestId'),
    CASE WHEN json_extract(${data}, '$.kind')='guideline'
      AND json_extract(${data}, '$.title')='Recurring answer'
      AND json_extract(${data}, '$.projectId') IS NOT NULL
      AND json_extract(${data}, '$.actor.type')='human'
      AND json_extract(${data}, '$.createdBy.type')='human'
      THEN json_extract(${data}, '$.body') END`
}

function migratePageIndex(db) {
  db.exec('BEGIN IMMEDIATE')
  try {
    if (
      !db
        .prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='memory_page_heads'")
        .get()
    ) {
      db.exec(`CREATE TABLE memory_page_heads (
        tenant TEXT NOT NULL, page TEXT NOT NULL, version INTEGER NOT NULL, summary TEXT NOT NULL,
        rule_body TEXT, project TEXT AS (json_extract(summary, '$.projectId')),
        kind TEXT AS (json_extract(summary, '$.kind')), stamp TEXT AS (json_extract(summary, '$.createdAt')),
        deleted INTEGER AS (json_extract(summary, '$.deleted')),
        handoff INTEGER AS (kind='note' AND deleted=0 AND lower(page) GLOB '${handoff}'),
        PRIMARY KEY (tenant,page)
      ) WITHOUT ROWID;
      CREATE TRIGGER memory_page_heads_insert AFTER INSERT ON revisions BEGIN
        INSERT INTO memory_page_heads(tenant,page,version,summary,rule_body)
          VALUES(${projectHead('NEW')})
          ON CONFLICT(tenant,page) DO UPDATE SET version=excluded.version,
            summary=excluded.summary, rule_body=excluded.rule_body
            WHERE excluded.version>memory_page_heads.version;
      END;
      INSERT INTO memory_page_heads(tenant,page,version,summary,rule_body)
        SELECT ${projectHead('r')} FROM
          (SELECT tenant,page,MAX(version) AS version FROM revisions GROUP BY tenant,page) latest
          JOIN revisions r USING(tenant,page,version);
      CREATE INDEX memory_page_recent ON memory_page_heads(tenant,stamp DESC,page);
      CREATE INDEX memory_project_pages ON memory_page_heads(tenant,project,page);
      CREATE INDEX memory_project_recent ON memory_page_heads(tenant,project,stamp DESC,page);
      CREATE INDEX memory_visible_projects ON memory_page_heads(tenant,deleted,project);
      CREATE INDEX memory_kind_recent ON memory_page_heads(tenant,kind,stamp DESC,page);
      CREATE INDEX memory_handoff_id ON memory_page_heads(tenant,page) WHERE handoff=1;
      CREATE INDEX memory_handoff_recent ON memory_page_heads(tenant,stamp DESC,page) WHERE handoff=1;
      CREATE INDEX memory_rules_recent ON memory_page_heads(tenant,stamp DESC,page)
        WHERE rule_body IS NOT NULL;`)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function readIndexQuery(params, fail, validId) {
  for (const [key] of params) {
    if (!indexKeys.has(key) || (key !== 'id' && params.getAll(key).length !== 1)) {
      fail(400, 'Invalid memory index parameter')
    }
  }
  function flag(key) {
    const value = params.get(key)
    if (value !== null && value !== 'true' && value !== 'false')
      fail(400, 'Invalid memory index flag')
    return value === 'true'
  }
  const order = params.get('order') ?? 'id'
  const kind = params.get('kind')
  const project = params.get('projectId')
  const search = params.get('q') ?? ''
  const ids = params.getAll('id')
  if (
    !['id', 'recent'].includes(order) ||
    (kind !== null && !['note', 'decision', 'guideline'].includes(kind)) ||
    (project !== null && (!project.trim() || project.length > 256)) ||
    search.length > 512 ||
    ids.length > pageSize ||
    ids.some((id) => !validId(id))
  )
    fail(400, 'Invalid memory index query')
  let after = params.get('after')
  let stamp
  if (after !== null && order === 'recent') {
    const parts = after.split('|')
    if (parts.length !== 2 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(parts[0])) {
      fail(400, 'Invalid memory index cursor')
    }
    stamp = parts[0]
    after = parts[1]
  }
  if (after !== null && !validId(after)) fail(400, 'Invalid memory index cursor')
  return {
    ids,
    order,
    kind,
    project,
    search: search.trim().toLowerCase(),
    after,
    stamp,
    deleted: flag('includeDeleted'),
    deletedProjects: flag('includeDeletedProjects'),
    handoffs: flag('handoffsOnly'),
    rules: flag('recurringOnly')
  }
}

const searchableFields = [
  'title',
  'body',
  'kind',
  'projectId',
  'actor.type',
  'actor.id',
  'createdBy.type',
  'createdBy.id'
]

export function openPageIndex(db, { fail, validId }) {
  migratePageIndex(db)
  db.function('memory_lower', { deterministic: true }, (value) => value?.toLowerCase() ?? '')
  db.function('memory_valid_rule', { deterministic: true }, (value) =>
    Number(readRule(value) !== null)
  )
  db.function('memory_valid_handoff', { deterministic: true }, (revision) =>
    Number(validHandoffContent(JSON.parse(revision)))
  )
  function list(identity, params, validHandoffsOnly = false) {
    if (identity.actor.type !== 'human') fail(403, 'Only the account can browse the memory index')
    const query = readIndexQuery(params, fail, validId)
    const clauses = ['h.tenant=?']
    const args = [identity.tenant]
    function where(condition, ...values) {
      clauses.push(condition)
      args.push(...values)
    }
    if (!query.deleted || query.handoffs) where('h.deleted=0')
    if (query.kind) where('h.kind=?', query.kind)
    if (query.project !== null) where('h.project=?', query.project)
    if (query.handoffs || validHandoffsOnly) where('h.handoff=1')
    if (validHandoffsOnly) where('memory_valid_handoff(r.data)')
    if (query.rules) where('h.rule_body IS NOT NULL AND memory_valid_rule(h.rule_body)')
    if (query.ids.length) where(`h.page IN (${query.ids.map(() => '?').join(',')})`, ...query.ids)
    if (query.stamp)
      where('h.stamp<=? AND (h.stamp<? OR h.page>?)', query.stamp, query.stamp, query.after)
    else if (query.after) where('h.page>?', query.after)
    const join =
      query.search || validHandoffsOnly
        ? 'JOIN revisions r ON r.tenant=h.tenant AND r.page=h.page AND r.version=h.version'
        : ''
    if (query.search) {
      where(
        '(' +
          searchableFields
            .map((field) => `instr(memory_lower(json_extract(r.data, '$.${field}')),?)>0`)
            .join(' OR ') +
          ')',
        ...searchableFields.map(() => query.search)
      )
    }
    const order = query.order === 'recent' ? 'h.stamp DESC,h.page' : 'h.page'
    // The ID-ordered primary key also satisfies the sort but would visit every receipt in the tenant.
    const handoffIndex =
      (query.handoffs || validHandoffsOnly) &&
      query.order === 'id' &&
      !query.project &&
      !query.ids.length
        ? 'INDEXED BY memory_handoff_id'
        : ''
    db.exec('BEGIN')
    try {
      const rows = db
        .prepare(`SELECT h.summary,h.rule_body FROM memory_page_heads h ${handoffIndex} ${join}
        WHERE ${clauses.join(' AND ')} ORDER BY ${order} LIMIT ${pageSize + 1}`)
        .all(...args)
      const pages = rows.slice(0, pageSize).map((row) => {
        const page = JSON.parse(row.summary)
        const question = row.rule_body && readRule(row.rule_body)?.question
        if (question) page.recurringQuestion = question
        return page
      })
      const projects = db
        .prepare(`SELECT DISTINCT project FROM memory_page_heads
        WHERE tenant=? AND project IS NOT NULL ${query.deletedProjects || query.deleted ? '' : 'AND deleted=0'}
        ORDER BY project`)
        .all(identity.tenant)
        .map((row) => row.project)
      const last = pages.at(-1)
      const next =
        rows.length > pageSize
          ? query.order === 'recent'
            ? last.createdAt + '|' + last.pageId
            : last.pageId
          : null
      db.exec('COMMIT')
      return { pages, projects, next }
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  return list
}
