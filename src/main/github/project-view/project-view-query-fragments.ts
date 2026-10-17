const FIELD_VALUES_PAGE_SIZE = 100

// ─── GraphQL query fragments ───────────────────────────────────────────

export const FIELD_CONFIG_FRAGMENT = `
fragment FieldConfig on ProjectV2FieldConfiguration {
  __typename
  ... on ProjectV2Field { id name dataType }
  ... on ProjectV2SingleSelectField {
    id
    name
    dataType
    options { id name color }
  }
  ... on ProjectV2IterationField {
    id
    name
    dataType
    configuration {
      iterations { id title startDate duration }
      completedIterations { id title startDate duration }
    }
  }
}
`

export function supportsProjectExtendedFields(host?: string): boolean {
  const hostname = host
    ?.toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '')
  // Why: older GitHub Enterprise schemas may not expose these GitHub.com fields.
  return !hostname || hostname === 'github.com'
}

export function itemContentSelection(
  includeParent: boolean,
  includeSubIssuesSummary: boolean
): string {
  const parentFrag = includeParent ? 'parent { number title url }' : ''
  const subIssuesSummaryFrag = includeSubIssuesSummary
    ? 'subIssuesSummary { completed total percentCompleted }'
    : ''
  return `
    __typename
    ... on Issue {
      id
      number
      title
      url
      state
      stateReason
      repository { nameWithOwner }
      assignees(first:5) { nodes { login name avatarUrl } }
      labels(first:10) { nodes { name color } }
      issueType { id name color description }
      ${parentFrag}
      ${subIssuesSummaryFrag}
    }
    ... on PullRequest {
      id
      number
      title
      url
      state
      isDraft
      repository { nameWithOwner }
      assignees(first:5) { nodes { login name avatarUrl } }
      labels(first:10) { nodes { name color } }
    }
    ... on DraftIssue { id title body }
  `
}

export function fieldValuesSelection(includeLinkedPullRequests: boolean): string {
  const linkedPullRequestsFrag = includeLinkedPullRequests
    ? `
      ... on ProjectV2ItemFieldPullRequestValue {
        field { ...FieldConfig }
        pullRequests(first:10) {
          totalCount
          pageInfo { hasNextPage }
          nodes { number title url }
        }
      }
    `
    : ''
  return `
  fieldValues(first:${FIELD_VALUES_PAGE_SIZE}) {
    pageInfo { hasNextPage }
    nodes {
      __typename
      ... on ProjectV2ItemFieldSingleSelectValue { field { ...FieldConfig } name color optionId }
      ... on ProjectV2ItemFieldIterationValue    { field { ...FieldConfig } title startDate duration iterationId }
      ... on ProjectV2ItemFieldTextValue         { field { ...FieldConfig } text }
      ... on ProjectV2ItemFieldNumberValue       { field { ...FieldConfig } number }
      ... on ProjectV2ItemFieldDateValue         { field { ...FieldConfig } date }
      ... on ProjectV2ItemFieldLabelValue        { field { ...FieldConfig } labels(first:10) { nodes { name color } } }
      ... on ProjectV2ItemFieldUserValue         { field { ...FieldConfig } users(first:5) { nodes { login name avatarUrl } } }
      ${linkedPullRequestsFrag}
    }
  }
`
}
