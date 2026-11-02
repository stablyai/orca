const GITLAB_DRAFT_TITLE_PREFIX =
  /^(?:(?:draft|wip)\s*:\s*|(?:draft|wip)\s+-\s+|\[(?:draft|wip)\]\s*|\((?:draft|wip)\)\s*)/i

export function stripGitLabDraftTitlePrefix(title: string): string | null {
  const readyTitle = title.replace(GITLAB_DRAFT_TITLE_PREFIX, '')
  return readyTitle === title ? null : readyTitle
}
