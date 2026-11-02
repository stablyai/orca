import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import Link from 'next/link'
import { findNeighbour } from 'fumadocs-core/page-tree'
import { Prose } from '@/components/docs/prose'
import { source } from '@/lib/source'

const siteUrl = 'https://www.onorca.dev'

export function generateStaticParams() {
  return source.generateParams()
}

export async function generateMetadata({
  params
}: {
  params: Promise<{ slug?: string[] }>
}): Promise<Metadata> {
  const { slug } = await params
  const page = source.getPage(slug)
  if (!page) {
    return {}
  }
  const { title, description, keywords } = page.data
  const ogImagePath = slug && slug.length > 0 ? `/docs/og/${slug.join('/')}` : '/docs/og'
  return {
    title: `${title} — Orca Docs`,
    description: description ?? `${title} — Orca documentation.`,
    keywords,
    alternates: { canonical: `${siteUrl}${page.url}` },
    openGraph: {
      type: 'article',
      title: `${title} — Orca Docs`,
      description: description ?? `${title} — Orca documentation.`,
      url: `${siteUrl}${page.url}`,
      siteName: 'Orca',
      images: [
        {
          url: ogImagePath,
          width: 1200,
          height: 630,
          alt: `${title} — Orca Docs`
        }
      ]
    },
    twitter: {
      card: 'summary_large_image',
      title: `${title} — Orca Docs`,
      description: description ?? `${title} — Orca documentation.`,
      images: [ogImagePath]
    }
  }
}

export default async function DocsPage({ params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await params
  const page = source.getPage(slug)
  if (!page) {
    notFound()
  }

  const MdxBody = page.data.body
  const { previous, next } = findNeighbour(source.pageTree, page.url)

  return (
    <article>
      <header className="mb-8">
        <h1 className="mb-3 text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
          {page.data.title}
        </h1>
        {page.data.description && (
          <p className="max-w-2xl text-lg leading-relaxed text-muted-foreground">
            {page.data.description}
          </p>
        )}
      </header>

      <Prose>
        <MdxBody />
      </Prose>

      <nav
        className="mt-16 flex flex-col items-stretch justify-between gap-3 border-t border-border pt-8 text-sm sm:flex-row sm:items-center sm:gap-4"
        aria-label="Page navigation"
      >
        {previous ? (
          <Link
            href={previous.url}
            className="group flex-1 rounded-xl border border-border bg-card p-4 transition-colors hover:border-ring/60 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <div className="mb-1 flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
              <ArrowLeft className="size-3.5" aria-hidden="true" />
              Previous
            </div>
            <div className="text-foreground">{previous.name}</div>
          </Link>
        ) : (
          <div className="flex-1" />
        )}
        {next ? (
          <Link
            href={next.url}
            className="group flex-1 rounded-xl border border-border bg-card p-4 text-right transition-colors hover:border-ring/60 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <div className="mb-1 flex items-center justify-end gap-1.5 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
              Next
              <ArrowRight className="size-3.5" aria-hidden="true" />
            </div>
            <div className="text-foreground">{next.name}</div>
          </Link>
        ) : (
          <div className="flex-1" />
        )}
      </nav>
    </article>
  )
}
