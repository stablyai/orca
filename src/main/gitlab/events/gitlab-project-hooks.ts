// A GitLab project's webhooks through the owner's glab sign-in on this host. The signing token goes
// on stdin, never in the process list.
import { z } from 'zod'
import type { GitLabHookFlag } from '../../../shared/automation-gitlab-triggers'
import { glabExecFileAsync } from '../../git/command-runner/hosted-cli/glab-exec-file'
import { encodedProject } from '../projects/project-path-encoding'

export type GitLabProjectHook = {
  url: string
  signingToken: string
  flag: GitLabHookFlag
  /** Shown in the project's Webhooks settings. */
  name: string
}

export type GitLabProjectHooks = {
  create: (host: string | undefined, project: string, hook: GitLabProjectHook) => Promise<number>
  update: (
    host: string | undefined,
    project: string,
    id: number,
    hook: GitLabProjectHook
  ) => Promise<void>
  remove: (host: string | undefined, project: string, id: number) => Promise<void>
}

const SavedHook = z.object({ id: z.number().int() })

function hostArgs(host: string | undefined): string[] {
  return host ? ['--hostname', host] : []
}

function bodyOf(hook: GitLabProjectHook): string {
  return JSON.stringify({
    url: hook.url,
    name: hook.name,
    description: 'Starts an Orca bot automation. Made and kept by Orca.',
    signing_token: hook.signingToken,
    push_events: false,
    enable_ssl_verification: true,
    [hook.flag]: true
  })
}

// glab's error ends with GitLab's own answer, e.g. "403 Forbidden".
function refusal(project: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error)
  const forbidden = /\b40[13]\b/.test(detail)
  return new Error(
    forbidden
      ? `GitLab refused a webhook on ${project}: adding one needs the Maintainer role there, with glab signed in on this computer.`
      : `GitLab couldn't save the webhook on ${project}: ${detail.split('\n')[0]}`
  )
}

async function send(
  host: string | undefined,
  method: 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: string
): Promise<string> {
  const { stdout } = await glabExecFileAsync(
    [
      'api',
      ...hostArgs(host),
      '-X',
      method,
      path,
      ...(body === undefined ? [] : ['-H', 'Content-Type: application/json', '--input', '-'])
    ],
    body === undefined ? {} : { stdin: body }
  )
  return stdout
}

export const glabProjectHooks: GitLabProjectHooks = {
  async create(host, project, hook) {
    try {
      const answer = await send(
        host,
        'POST',
        `projects/${encodedProject(project)}/hooks`,
        bodyOf(hook)
      )
      return SavedHook.parse(JSON.parse(answer)).id
    } catch (error) {
      throw refusal(project, error)
    }
  },
  async update(host, project, id, hook) {
    try {
      await send(host, 'PUT', `projects/${encodedProject(project)}/hooks/${id}`, bodyOf(hook))
    } catch (error) {
      throw refusal(project, error)
    }
  },
  async remove(host, project, id) {
    try {
      await send(host, 'DELETE', `projects/${encodedProject(project)}/hooks/${id}`)
    } catch (error) {
      // Already gone, or the project with it.
      if (!/\b404\b/.test(error instanceof Error ? error.message : String(error))) {
        throw refusal(project, error)
      }
    }
  }
}
