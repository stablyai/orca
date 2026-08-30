import type { ReactNode } from 'react'
import { DocsLayout } from 'fumadocs-ui/layouts/docs'
import { DocsHeader } from '@/components/layout/DocsHeader'
import { DocsFooter } from '@/components/layout/DocsFooter'
import SearchTrigger from '@/components/docs/SearchTrigger'
import DocsMobileNav from '@/components/docs/DocsMobileNav'
import { source } from '@/lib/source'

export default function DocsSegmentLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-[#000000] selection:bg-white/20 selection:text-white flex flex-col">
      <DocsHeader />
      <DocsLayout
        tree={source.pageTree}
        nav={{ enabled: false }}
        sidebar={{
          collapsible: false,
          banner: <SearchTrigger />,
          className: 'bg-transparent border-e-white/[0.06] [&_#nd-sidebar]:bg-transparent'
        }}
        containerProps={{
          className: 'flex-1 mt-14'
        }}
      >
        <div className="min-w-0 w-full max-w-[820px] mx-auto [grid-area:main] px-4 sm:px-6 md:px-8 pt-6 pb-20 md:pb-24">
          <DocsMobileNav />
          {children}
        </div>
      </DocsLayout>
      <DocsFooter />
    </div>
  )
}
