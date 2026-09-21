import { createMDX } from 'fumadocs-mdx/next'
import type { NextConfig } from 'next'

// Keep human-facing animations intact while preventing crawlers from burning
// transfer on multi-MB demo GIFs (serve JPG posters instead).
const crawlerUserAgentPattern =
  '.*(?:[Bb][Oo][Tt]|[Cc][Rr][Aa][Ww][Ll]|[Ss][Pp][Ii][Dd][Ee][Rr]|GPTBot|ChatGPT-User|OAI-SearchBot|ClaudeBot|Claude-User|anthropic-ai|PerplexityBot|CCBot|Google-Extended|Applebot|facebookexternalhit|Twitterbot|LinkedInBot|Slackbot|Discordbot|TelegramBot|WhatsApp|SkypeUriPreview|Pinterest|Ahrefs|Semrush|MJ12|DotBot|PetalBot|Bytespider|Amazonbot|DuckDuckBot|Baiduspider|Yandex).*'

const crawlerGifPosterRewrites = [
  ['/docs/orca-design-mode.gif', '/docs/posters/orca-design-mode.jpg'],
  ['/docs/tab-split.gif', '/docs/posters/tab-split.jpg']
] as const

const nextConfig: NextConfig = {
  // Keep this zone's Next assets separate from the marketing zone.
  assetPrefix: '/docs-static',
  turbopack: {
    root: process.cwd()
  },
  async rewrites() {
    const crawlerUserAgent = [
      {
        type: 'header' as const,
        key: 'user-agent',
        value: crawlerUserAgentPattern
      }
    ]

    return {
      beforeFiles: crawlerGifPosterRewrites.map(([source, destination]) => ({
        source,
        destination,
        has: crawlerUserAgent
      }))
    }
  },
  async headers() {
    const media = 'public, max-age=2592000, stale-while-revalidate=86400'
    return [
      {
        source: '/docs/:all*(mp4|gif)',
        headers: [{ key: 'Cache-Control', value: media }]
      },
      {
        source: '/docs/posters/:path*',
        headers: [{ key: 'Cache-Control', value: media }]
      },
      {
        source: '/docs/videos/:path*',
        headers: [{ key: 'Cache-Control', value: media }]
      }
    ]
  }
}

const withMDX = createMDX()

export default withMDX(nextConfig)
