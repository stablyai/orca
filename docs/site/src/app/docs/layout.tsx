import type { ReactNode } from 'react'
import { DocsLayout } from 'fumadocs-ui/layouts/docs'
import { DocsHeader } from '@/components/layout/DocsHeader'
import { DocsFooter } from '@/components/layout/DocsFooter'
import SearchTrigger from '@/components/docs/SearchTrigger'
import DocsMobileNav from '@/components/docs/DocsMobileNav'
import EmptyDocsNavTitle from '@/components/docs/EmptyDocsNavTitle'
import { source } from '@/lib/source'

export default function DocsSegmentLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground selection:bg-accent selection:text-accent-foreground">
      <DocsHeader />
      <DocsLayout
        tree={source.pageTree}
        nav={{ enabled: false }}
        searchToggle={{ enabled: false }}
        themeSwitch={{ enabled: false }}
        slots={{ navTitle: EmptyDocsNavTitle }}
        sidebar={{
          collapsible: false,
          banner: <SearchTrigger />,
          className: 'border-e-border/60 bg-transparent [&_#nd-sidebar]:bg-transparent'
        }}
        containerProps={{
          className: 'mt-14 flex-1 [--fd-banner-height:3.5rem]'
        }}
      >
        <main className="mx-auto min-w-0 w-full max-w-[820px] px-4 pb-20 pt-6 [grid-area:main] sm:px-6 md:px-8 md:pb-24">
          <DocsMobileNav />
          {children}
        </main>
      </DocsLayout>
      <DocsFooter />
    </div>
  )
}
