// Keep the isolated Memory service's content checks in sync with shared/commander/handoff-content.
// The head index already restricts candidates to active notes with canonical handoff IDs.
const progressHeading = '## Progress\n\n'
const nextHeading = '\n\n## Next step\n\n'
const decodedLength = (text) => text.replace(/^\\(\\*## Next step)$/gm, '$1').length

export function validHandoffContent({ title, body }) {
  if (!title.trim() || title.length > 240 || !body.startsWith(progressHeading)) return false
  const at = body.indexOf(nextHeading, progressHeading.length)
  if (at < 0 || body.includes(nextHeading, at + nextHeading.length)) return false
  return (
    decodedLength(body.slice(progressHeading.length, at)) <= 4000 &&
    decodedLength(body.slice(at + nextHeading.length)) <= 4000
  )
}
