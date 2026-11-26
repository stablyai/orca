const guidelineFilter = `kind='guideline' AND deleted=0
  AND json_extract(summary,'$.actor.type')='human'
  AND json_extract(summary,'$.title')<>'Recurring answer'`

export function openWorkerGuidance(db, fail) {
  db.exec(`CREATE INDEX IF NOT EXISTS memory_guidance_project ON memory_page_heads(tenant,project,page)
    WHERE ${guidelineFilter}`)
  // Each scope is an ordered index range. SQLite merges them in page order.
  const scope = (
    condition
  ) => `SELECT h.page AS page, r.data FROM memory_page_heads h INDEXED BY memory_guidance_project
    JOIN revisions r ON r.tenant=h.tenant AND r.page=h.page AND r.version=h.version
    WHERE h.tenant=? AND ${condition} AND ${guidelineFilter}`
  const read = db.prepare(
    `${scope('h.project=?')} UNION ALL ${scope('h.project IS NULL')} ORDER BY page`
  )
  return (identity, params) => {
    if (identity.actor.type !== 'human') fail(403, 'Only the account can read worker guidance')
    const project = params.get('projectId')
    if (params.size !== 1 || !project?.trim() || project.length > 256)
      fail(400, 'Invalid worker project')
    const guidelines = []
    let remaining = 8000
    let truncated = false
    for (const { data } of read.iterate(identity.tenant, project, identity.tenant)) {
      const { title, version, body } = JSON.parse(data)
      const entry = `${title} (v${version})\n${body}`
      const cost = entry.length + 2
      if (cost > remaining) {
        truncated = true
      } else {
        remaining -= cost
        guidelines.push(entry)
      }
      // Even a one-character title at v1 with an empty body costs nine units.
      if (remaining < 9 && truncated) break
    }
    return { guidelines, truncated }
  }
}
