export class MobileNativeChatDraftEditGenerations {
  private composerGeneration = 0
  private readonly byDraft = new Map<string, number>()

  advance(draftKey: string): void {
    this.composerGeneration += 1
    this.byDraft.set(draftKey, this.readDraft(draftKey) + 1)
  }

  readonly readComposer = (): number => this.composerGeneration

  readDraft(draftKey: string): number {
    return this.byDraft.get(draftKey) ?? 0
  }

  isCurrent(draftKey: string, generation: number): boolean {
    return this.readDraft(draftKey) === generation
  }
}
