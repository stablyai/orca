export function trackE2eFailures(failures, records, now = new Date()) {
  const known = []
  const untracked = []
  const invalid = []
  const active = (Array.isArray(records) ? records : [records]).filter((record) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      invalid.push(record)
      return false
    }
    const expiry = new Date(`${record.expires}T23:59:59Z`)
    const valid =
      typeof record.file === 'string' &&
      typeof record.title === 'string' &&
      typeof record.message === 'string' &&
      record.message.length > 0 &&
      /^@[\w-]+(?:\/[\w-]+)?$/.test(record.owner ?? '') &&
      /^https:\/\/github\.com\/stablyai\/orca\/issues\/\d+$/.test(record.issue ?? '') &&
      /^\d{4}-\d{2}-\d{2}$/.test(record.expires ?? '') &&
      Number.isFinite(expiry.getTime()) &&
      expiry.toISOString().slice(0, 10) === record.expires &&
      expiry.getTime() >= now.getTime()
    if (!valid) {
      invalid.push(record)
    }
    return valid
  })
  for (const failure of failures) {
    const record = active.find(
      (entry) =>
        entry.file === failure.file &&
        entry.title === failure.title &&
        entry.project === failure.project &&
        failure.message.includes(entry.message)
    )
    if (record) {
      known.push({ ...failure, tracking: record })
    } else {
      untracked.push(failure)
    }
  }
  return { known, untracked, invalid }
}
