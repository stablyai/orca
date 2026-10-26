export type ExternalAgentParentLink = {
  parentPaneKey: string
  taskId: string
  displayName?: string
}

export class RuntimeExternalParentLinks {
  private readonly links = new Map<string, ExternalAgentParentLink>()

  set(childPaneKey: string, link: ExternalAgentParentLink): void {
    this.links.set(childPaneKey, { ...link })
  }

  delete(childPaneKey: string): void {
    this.links.delete(childPaneKey)
  }

  entries(): readonly [string, ExternalAgentParentLink][] {
    return [...this.links].map(([paneKey, link]) => [paneKey, { ...link }])
  }
}
