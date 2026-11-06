/** A tab chip label: the mailbox name, widened by domain only when two accounts share it. */
export function claudeAccountShortLabel(email: string, emails: readonly string[]): string {
  const local = email.includes('@') ? email.slice(0, email.indexOf('@')) : email
  const sameLocal = emails.filter((candidate) => {
    const other = candidate.includes('@') ? candidate.slice(0, candidate.indexOf('@')) : candidate
    return other === local
  }).length
  if (sameLocal <= 1 || local.length === 0) {
    return local || email
  }
  const domain = email.split('@')[1]?.split('.')[0]
  return domain ? `${local}@${domain}` : local
}
