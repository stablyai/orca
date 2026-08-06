function candidateSignature(candidate) {
  return JSON.stringify({
    filePath: candidate.filePath,
    kind: candidate.kind,
    text: candidate.text,
    dynamic: candidate.dynamic
  })
}

function countBySignature(candidates) {
  const counts = new Map()
  for (const candidate of candidates) {
    const signature = candidateSignature(candidate)
    counts.set(signature, (counts.get(signature) ?? 0) + 1)
  }
  return counts
}

export function findNewLocalizationCandidates(reports, allowlist) {
  const allowedCounts = new Map(allowlist.map((entry) => [candidateSignature(entry), entry.count]))
  const seenCounts = countBySignature(reports)
  const newCandidates = []

  for (const report of reports) {
    const signature = candidateSignature(report)
    const seenCount = seenCounts.get(signature) ?? 0
    const allowedCount = allowedCounts.get(signature) ?? 0
    if (seenCount > allowedCount) {
      newCandidates.push(report)
      seenCounts.set(signature, seenCount - 1)
    }
  }

  return newCandidates
}

export function findStaleLocalizationAllowlistEntries(reports, allowlist) {
  const seenCounts = countBySignature(reports)
  return allowlist.flatMap((entry) => {
    const seenCount = seenCounts.get(candidateSignature(entry)) ?? 0
    return seenCount < entry.count ? [{ ...entry, seenCount }] : []
  })
}

export function formatStaleLocalizationAllowlistEntries(entries) {
  return entries
    .map(
      (entry) =>
        `${entry.filePath} ${entry.kind}: ${JSON.stringify(entry.text)} (allowlisted ${entry.count}, found ${entry.seenCount})`
    )
    .join('\n')
}
