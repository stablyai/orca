'use client'

import { SidebarTrigger } from 'fumadocs-ui/layouts/docs/slots/sidebar'
import { PanelLeft } from 'lucide-react'
import SearchTrigger from './SearchTrigger'

export default function DocsMobileNav() {
  return (
    <div className="mb-5 flex items-center gap-2 md:hidden">
      <SidebarTrigger
        type="button"
        aria-label="Toggle navigation"
        className="inline-flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-card text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <PanelLeft className="size-4" aria-hidden="true" />
      </SidebarTrigger>
      <SearchTrigger />
    </div>
  )
}
