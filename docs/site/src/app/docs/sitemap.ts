import type { MetadataRoute } from 'next'
import { source } from '@/lib/source'

const siteUrl = 'https://orca.dev'

export default function sitemap(): MetadataRoute.Sitemap {
  return source.getPages().map((page) => ({
    url: `${siteUrl}${page.url}`,
    lastModified: new Date(),
    changeFrequency: 'weekly',
    priority: page.url === '/docs' ? 0.9 : 0.7
  }))
}
