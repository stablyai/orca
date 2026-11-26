import {
  NGIT_STATUS_ACTIONS,
  type NgitMutationResult,
  type NgitStatusAction,
  type NgitWorkItem
} from '../../shared/ngit/ngit-work-item-types'
import { execNgit, type NgitExec } from './ngit-cli'

export type NgitWriteTarget = {
  /** A directory inside the repository, so its `nostr.signer` setting applies. */
  cwd: string
  /** `ngit --repo` value: a remote name or a nostr:// URL. */
  repo: string
}

async function publish(
  target: NgitWriteTarget,
  args: string[],
  exec: NgitExec
): Promise<NgitMutationResult> {
  try {
    await exec(['--repo', target.repo, ...args, '--json'], target.cwd)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

// `--flag=value` keeps text beginning with a dash from being read as another flag.
export function createNgitIssue(
  target: NgitWriteTarget,
  title: string,
  body: string,
  exec: NgitExec = execNgit
): Promise<NgitMutationResult> {
  return publish(target, ['issue', 'create', `--subject=${title}`, `--body=${body}`], exec)
}

export function addNgitComment(
  target: NgitWriteTarget,
  type: NgitWorkItem['type'],
  eventId: string,
  body: string,
  exec: NgitExec = execNgit
): Promise<NgitMutationResult> {
  return publish(target, [type, 'comment', eventId, `--body=${body}`], exec)
}

export function setNgitWorkItemStatus(
  target: NgitWriteTarget,
  type: NgitWorkItem['type'],
  eventId: string,
  action: NgitStatusAction,
  exec: NgitExec = execNgit
): Promise<NgitMutationResult> {
  const allowed: readonly string[] = NGIT_STATUS_ACTIONS[type]
  if (!allowed.includes(action)) {
    return Promise.resolve({ ok: false, error: `ngit cannot ${action} this ${type}.` })
  }
  return publish(target, [type, action, eventId], exec)
}
