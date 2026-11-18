// Pages whose text an action's effects must not return to the agent, such as a dialog showing a
// secret the agent may click but must never read. Features register who decides; nothing else reads.
export type PageTextWithheld = (page: { browserPageId: string; url: string }) => boolean

let decide: PageTextWithheld | null = null

export function setPageTextWithheld(next: PageTextWithheld | null): void {
  decide = next
}

export function isPageTextWithheld(page: { browserPageId: string; url: string }): boolean {
  return decide?.(page) ?? false
}
