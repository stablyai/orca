import { ListRow } from './ui/ListRow'

type Props = {
  assignee?: string
  priorityName?: string
  projectName: string
}

/** Jira's label/value pairs for the detail sheet's Details group, skipping empty ones. */
export function jiraDetailMetaRows({ assignee, priorityName, projectName }: Props) {
  const rows: [string, string | undefined][] = [
    ['Assignee', assignee],
    ['Priority', priorityName],
    ['Project', projectName]
  ]
  return rows.flatMap(([label, value]) => (value ? [{ label, value }] : []))
}

// The detail sheet owns the surrounding group, which draws the separators between rows.
export function JiraDetailMeta(props: Props) {
  return (
    <>
      {jiraDetailMetaRows(props).map((row) => (
        <ListRow key={row.label} title={row.label} value={row.value} />
      ))}
    </>
  )
}
