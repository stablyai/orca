import { MobileWebBrokerError } from './mobile-web-broker-error'

const MAX_TASK_TARGETS = 4_096

export type MobileWebGitLabTaskTarget = {
  repoId: string
  number: number
  type: 'issue' | 'mr'
  projectRef?: { host: string; path: string }
}

export type MobileWebGitHubTaskTarget = {
  repoId: string
  number: number
  type: 'issue' | 'pr'
}

export type MobileWebHostedTaskTarget =
  | ({ provider: 'github' } & MobileWebGitHubTaskTarget)
  | ({ provider: 'gitlab' } & MobileWebGitLabTaskTarget)

export type MobileWebLinearTaskTarget = {
  issueId: string
  workspaceId?: string
}

export type MobileWebGitHubProjectTaskTarget = {
  owner: string
  host: string
  ownerType: 'organization' | 'user'
  projectNumber: number
  viewId: string
  queryOverride?: string
  rowId: string
  itemType: 'ISSUE' | 'PULL_REQUEST' | 'DRAFT_ISSUE' | 'REDACTED'
  repository: string | null
  number: number | null
}

export class MobileWebTaskTargetAuthority {
  private readonly pageIdByTargetKey = new Map<string, string>()
  private readonly gitHubTargetByPageId = new Map<string, MobileWebGitHubTaskTarget>()
  private readonly gitLabTargetByPageId = new Map<string, MobileWebGitLabTaskTarget>()
  private readonly linearTargetByPageId = new Map<string, MobileWebLinearTaskTarget>()
  private readonly projectTargetByPageId = new Map<string, MobileWebGitHubProjectTaskTarget>()
  private nextHandle = 0

  constructor(private readonly randomBytes: (length: number) => Uint8Array) {}

  registerGitLab(target: MobileWebGitLabTaskTarget): string {
    const key = `gitlab:${JSON.stringify(target)}`
    const current = this.pageIdByTargetKey.get(key)
    if (current) {
      return current
    }
    if (this.targetCount() >= MAX_TASK_TARGETS) {
      throw new MobileWebBrokerError('unavailable')
    }
    const pageId = this.createHandle()
    this.pageIdByTargetKey.set(key, pageId)
    this.gitLabTargetByPageId.set(pageId, copyGitLabTarget(target))
    return pageId
  }

  resolveGitLab(pageId: string): MobileWebGitLabTaskTarget {
    const target = this.gitLabTargetByPageId.get(pageId)
    if (!target) {
      throw new MobileWebBrokerError('not_found')
    }
    return copyGitLabTarget(target)
  }

  registerGitHub(target: MobileWebGitHubTaskTarget): string {
    const key = `github:${JSON.stringify(target)}`
    const current = this.pageIdByTargetKey.get(key)
    if (current) {
      return current
    }
    if (this.targetCount() >= MAX_TASK_TARGETS) {
      throw new MobileWebBrokerError('unavailable')
    }
    const pageId = this.createHandle()
    this.pageIdByTargetKey.set(key, pageId)
    this.gitHubTargetByPageId.set(pageId, { ...target })
    return pageId
  }

  resolveGitHub(pageId: string): MobileWebGitHubTaskTarget {
    const target = this.gitHubTargetByPageId.get(pageId)
    if (!target) {
      throw new MobileWebBrokerError('not_found')
    }
    return { ...target }
  }

  resolveHosted(pageId: string): MobileWebHostedTaskTarget {
    const gitHub = this.gitHubTargetByPageId.get(pageId)
    if (gitHub) {
      return { provider: 'github', ...gitHub }
    }
    const gitLab = this.gitLabTargetByPageId.get(pageId)
    if (gitLab) {
      return { provider: 'gitlab', ...copyGitLabTarget(gitLab) }
    }
    throw new MobileWebBrokerError('not_found')
  }

  assertHostedTarget(pageId: string, expected: MobileWebHostedTaskTarget): void {
    if (hostedTargetKey(this.resolveHosted(pageId)) !== hostedTargetKey(expected)) {
      throw new MobileWebBrokerError('conflict')
    }
  }

  registerLinear(target: MobileWebLinearTaskTarget): string {
    const key = `linear:${JSON.stringify(target)}`
    const current = this.pageIdByTargetKey.get(key)
    if (current) {
      return current
    }
    if (this.targetCount() >= MAX_TASK_TARGETS) {
      throw new MobileWebBrokerError('unavailable')
    }
    const pageId = this.createHandle()
    this.pageIdByTargetKey.set(key, pageId)
    this.linearTargetByPageId.set(pageId, { ...target })
    return pageId
  }

  resolveLinear(pageId: string): MobileWebLinearTaskTarget {
    const target = this.linearTargetByPageId.get(pageId)
    if (!target) {
      throw new MobileWebBrokerError('not_found')
    }
    return { ...target }
  }

  assertLinearTarget(pageId: string, expected: MobileWebLinearTaskTarget): void {
    if (linearTargetKey(this.resolveLinear(pageId)) !== linearTargetKey(expected)) {
      throw new MobileWebBrokerError('conflict')
    }
  }

  registerGitHubProject(target: MobileWebGitHubProjectTaskTarget): string {
    return this.register(`github-project:${JSON.stringify(target)}`, target)
  }

  resolveGitHubProject(pageId: string): MobileWebGitHubProjectTaskTarget {
    const target = this.projectTargetByPageId.get(pageId)
    if (!target) {
      throw new MobileWebBrokerError('not_found')
    }
    return { ...target }
  }

  assertGitHubProjectTarget(pageId: string, expected: MobileWebGitHubProjectTaskTarget): void {
    if (projectTargetKey(this.resolveGitHubProject(pageId)) !== projectTargetKey(expected)) {
      throw new MobileWebBrokerError('conflict')
    }
  }

  clear(): void {
    this.pageIdByTargetKey.clear()
    this.gitHubTargetByPageId.clear()
    this.gitLabTargetByPageId.clear()
    this.linearTargetByPageId.clear()
    this.projectTargetByPageId.clear()
  }

  private register(key: string, target: MobileWebGitHubProjectTaskTarget): string {
    const current = this.pageIdByTargetKey.get(key)
    if (current) {
      return current
    }
    if (this.targetCount() >= MAX_TASK_TARGETS) {
      throw new MobileWebBrokerError('unavailable')
    }
    const pageId = this.createHandle()
    this.pageIdByTargetKey.set(key, pageId)
    this.projectTargetByPageId.set(pageId, { ...target })
    return pageId
  }

  private targetCount(): number {
    return (
      this.gitHubTargetByPageId.size +
      this.gitLabTargetByPageId.size +
      this.linearTargetByPageId.size +
      this.projectTargetByPageId.size
    )
  }

  private createHandle(): string {
    const bytes = this.randomBytes(16)
    if (bytes.byteLength !== 16) {
      throw new MobileWebBrokerError('internal')
    }
    const counter = this.nextHandle.toString(36)
    this.nextHandle += 1
    return `task_target_${counter}_${Array.from(bytes, byteToHex).join('')}`
  }
}

function byteToHex(value: number): string {
  return value.toString(16).padStart(2, '0')
}

function copyGitLabTarget(target: MobileWebGitLabTaskTarget): MobileWebGitLabTaskTarget {
  return {
    ...target,
    projectRef: target.projectRef ? { ...target.projectRef } : undefined
  }
}

function hostedTargetKey(target: MobileWebHostedTaskTarget): string {
  return `${target.provider}:${JSON.stringify(target)}`
}

function linearTargetKey(target: MobileWebLinearTaskTarget): string {
  return JSON.stringify(target)
}

function projectTargetKey(target: MobileWebGitHubProjectTaskTarget): string {
  return JSON.stringify(target)
}
