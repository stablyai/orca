'use client'

import { SidebarTrigger } from 'fumadocs-ui/layouts/docs/slots/sidebar'
import { PanelLeft } from 'lucide-react'
import SearchTrigger from './SearchTrigger'

export default function DocsMobileNav() {
  return (
    <div className="mb-5 flex items-center gap-2 md:hidden">
      <SidebarTrigger
        type="button"
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-white/[0.16] bg-white/[0.05] text-white/80 transition-colors hover:border-white/[0.24] hover:bg-white/[0.08] hover:text-white"
      >
        <PanelLeft className="h-4 w-4" />
      </SidebarTrigger>
      <SearchTrigger />
    </div>
  )
}
