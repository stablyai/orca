import { createDocsOgImage } from '@/lib/docs-og-image'
import { source } from '@/lib/source'

export const runtime = 'nodejs'

export function generateStaticParams() {
  return source.generateParams().map(({ slug }) => ({
    slug: slug ?? []
  }))
}

export async function GET(_request: Request, { params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await params
  const page = source.getPage(slug?.length ? slug : undefined)

  if (!page) {
    return createDocsOgImage({ title: 'Documentation', url: '/docs' })
  }

  return createDocsOgImage({
    title: page.data.title,
    url: page.url
  })
}
