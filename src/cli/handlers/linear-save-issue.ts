import type {
  LinearSaveIssueRequest,
  LinearSaveIssueResult
} from '../../shared/linear-agent-access'
import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { formatLinearSaveIssue } from '../linear-format'
import { buildSaveIssueRequest } from '../linear-save-issue-request'

const LINEAR_WRITE_TIMEOUT_MS = 75_000

export const runLinearSaveIssue: CommandHandler = async ({ flags, client, cwd, json }) => {
  const request: LinearSaveIssueRequest = await buildSaveIssueRequest(flags, cwd, client.isRemote)
  const response = await client.call<LinearSaveIssueResult>('linear.saveIssue', request, {
    timeoutMs: LINEAR_WRITE_TIMEOUT_MS
  })
  printResult(response, json, formatLinearSaveIssue)
}
