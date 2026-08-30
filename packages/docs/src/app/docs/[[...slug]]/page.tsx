import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
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
        <h1 className="text-3xl sm:text-4xl font-bold text-white tracking-tight mb-3">
          {page.data.title}
        </h1>
        {page.data.description && (
          <p className="text-lg text-white/55 leading-relaxed max-w-2xl">{page.data.description}</p>
        )}
      </header>

      <Prose>
        <MdxBody />
      </Prose>

      <nav className="mt-16 pt-8 border-t border-white/[0.06] flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 sm:gap-4 text-sm">
        {previous ? (
          <Link
            href={previous.url}
            className="group flex-1 rounded-lg border border-white/[0.08] hover:border-white/[0.2] p-4 transition-colors"
          >
            <div className="text-[11px] font-mono uppercase tracking-widest text-white mb-1">
              ← Previous
            </div>
            <div className="text-white/85 group-hover:text-white">{previous.name}</div>
          </Link>
        ) : (
          <div className="flex-1" />
        )}
        {next ? (
          <Link
            href={next.url}
            className="group flex-1 rounded-lg border border-white/[0.08] hover:border-white/[0.2] p-4 transition-colors text-right"
          >
            <div className="text-[11px] font-mono uppercase tracking-widest text-white mb-1">
              Next →
            </div>
            <div className="text-white/85 group-hover:text-white">{next.name}</div>
          </Link>
        ) : (
          <div className="flex-1" />
        )}
      </nav>
    </article>
  )
}
