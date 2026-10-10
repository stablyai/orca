import { z } from 'zod'
import { BrowserError } from '../browser/browser-error'

const CertificateFailure = z
  .object({ browserPageId: z.string() })
  .passthrough()
  .nullable()
  .optional()
export const ElectronSidecarTabSchema = z
  .object({
    browserPageId: z.string(),
    index: z.number().optional(),
    active: z.boolean().optional(),
    certificateFailure: CertificateFailure
  })
  .passthrough()
const ElectronSidecarResult = z
  .object({
    browserPageId: z.string().optional(),
    sourceBrowserPageId: z.string().optional(),
    tab: ElectronSidecarTabSchema.optional()
  })
  .passthrough()

export type ElectronSidecarTab = z.infer<typeof ElectronSidecarTabSchema>

export type ElectronSidecarPage = {
  publicPageId: string
  sidecarPageId: string
  worktreeId?: string
}

export class ElectronSidecarTabRegistry {
  private readonly pagesByPublicId = new Map<string, ElectronSidecarPage>()
  private readonly pagesBySidecarId = new Map<string, ElectronSidecarPage>()
  private readonly activePageIdByWorktree = new Map<string, string>()

  clear(): void {
    this.pagesByPublicId.clear()
    this.pagesBySidecarId.clear()
    this.activePageIdByWorktree.clear()
  }

  register(sidecarPageId: string, requestedPageId: string | undefined, worktreeId?: string) {
    const publicPageId = requestedPageId || sidecarPageId
    const page = { publicPageId, sidecarPageId, worktreeId }
    this.pagesByPublicId.set(publicPageId, page)
    this.pagesBySidecarId.set(sidecarPageId, page)
    this.setActive(page)
    return page
  }
  find(publicPageId: string): ElectronSidecarPage | undefined {
    return this.pagesByPublicId.get(publicPageId)
  }

  require(publicPageId: string, worktreeId?: string): ElectronSidecarPage {
    const page = this.pagesByPublicId.get(publicPageId)
    if (!page || (worktreeId && page.worktreeId !== worktreeId)) {
      throw new BrowserError(
        'browser_tab_not_found',
        `Browser page ${publicPageId} was not found in this worktree.`
      )
    }
    return page
  }

  active(worktreeId?: string): ElectronSidecarPage {
    const publicPageId = this.activePageIdByWorktree.get(worktreeId ?? '')
    const page = publicPageId ? this.pagesByPublicId.get(publicPageId) : undefined
    if (!page) {
      throw new BrowserError('browser_no_tab', 'No browser tab is active in this worktree.')
    }
    return page
  }

  pageAt(worktreeId: string | undefined, index: number): ElectronSidecarPage {
    const page = [...this.pagesByPublicId.values()].filter(
      (candidate) => !worktreeId || candidate.worktreeId === worktreeId
    )[index]
    if (!page) {
      throw new BrowserError('browser_tab_not_found', `Browser tab index ${index} was not found.`)
    }
    return page
  }

  pageForSidecar(sidecarPageId: string): ElectronSidecarPage | undefined {
    return this.pagesBySidecarId.get(sidecarPageId)
  }

  setActive(page: ElectronSidecarPage): void {
    this.activePageIdByWorktree.set(page.worktreeId ?? '', page.publicPageId)
  }

  delete(page: ElectronSidecarPage): void {
    this.pagesByPublicId.delete(page.publicPageId)
    this.pagesBySidecarId.delete(page.sidecarPageId)
    const key = page.worktreeId ?? ''
    if (this.activePageIdByWorktree.get(key) === page.publicPageId) {
      const replacement = [...this.pagesByPublicId.values()].find(
        (candidate) => candidate.worktreeId === page.worktreeId
      )
      if (replacement) {
        this.activePageIdByWorktree.set(key, replacement.publicPageId)
      } else {
        this.activePageIdByWorktree.delete(key)
      }
    }
  }

  publicPageId(sidecarPageId: string): string {
    return this.pagesBySidecarId.get(sidecarPageId)?.publicPageId ?? sidecarPageId
  }

  reconcileTabs(tabs: ElectronSidecarTab[], worktreeId?: string): ElectronSidecarTab[] {
    const liveSidecarPageIds = new Set(tabs.map((tab) => tab.browserPageId))
    for (const page of this.pagesByPublicId.values()) {
      if (!liveSidecarPageIds.has(page.sidecarPageId)) {
        this.delete(page)
      }
    }
    return tabs
      .flatMap((tab) => {
        const page =
          this.pagesBySidecarId.get(tab.browserPageId) ??
          (worktreeId ? undefined : this.register(tab.browserPageId, undefined, undefined))
        if (!page || (worktreeId && page.worktreeId !== worktreeId)) {
          return []
        }
        if (tab.active === true) {
          this.setActive(page)
        }
        return [this.rewriteTab(tab)]
      })
      .map((tab, index) => ({ ...tab, index }))
  }

  rewriteResult(result: unknown): unknown {
    const parsed = ElectronSidecarResult.safeParse(result)
    if (!parsed.success) {
      return result
    }
    const rewritten = { ...parsed.data }
    if (rewritten.browserPageId) {
      rewritten.browserPageId = this.publicPageId(rewritten.browserPageId)
    }
    if (rewritten.sourceBrowserPageId) {
      rewritten.sourceBrowserPageId = this.publicPageId(rewritten.sourceBrowserPageId)
    }
    if (rewritten.tab) {
      rewritten.tab = this.rewriteTab(rewritten.tab)
    }
    return rewritten
  }

  private rewriteTab(tab: ElectronSidecarTab): ElectronSidecarTab {
    return {
      ...tab,
      browserPageId: this.publicPageId(tab.browserPageId),
      ...(tab.certificateFailure
        ? {
            certificateFailure: {
              ...tab.certificateFailure,
              browserPageId: this.publicPageId(tab.certificateFailure.browserPageId)
            }
          }
        : {})
    }
  }
}
