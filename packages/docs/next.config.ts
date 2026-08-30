import { createMDX } from 'fumadocs-mdx/next'
import type { NextConfig } from 'next'

// Keep human-facing animations intact while preventing crawlers from burning
// transfer on multi-MB demo GIFs (serve JPG posters instead).
const crawlerUserAgentPattern =
  '.*(?:[Bb][Oo][Tt]|[Cc][Rr][Aa][Ww][Ll]|[Ss][Pp][Ii][Dd][Ee][Rr]|GPTBot|ChatGPT-User|OAI-SearchBot|ClaudeBot|Claude-User|anthropic-ai|PerplexityBot|CCBot|Google-Extended|Applebot|facebookexternalhit|Twitterbot|LinkedInBot|Slackbot|Discordbot|TelegramBot|WhatsApp|SkypeUriPreview|Pinterest|Ahrefs|Semrush|MJ12|DotBot|PetalBot|Bytespider|Amazonbot|DuckDuckBot|Baiduspider|Yandex).*'

const crawlerGifPosterRewrites = [
  ['/docs/annotate-ai-diff.gif', '/docs/posters/annotate-ai-diff.jpg'],
  ['/docs/codex-account-switcher.gif', '/docs/posters/codex-account-switcher.jpg'],
  ['/docs/file-drag.gif', '/docs/posters/file-drag.jpg'],
  ['/docs/orca-design-mode.gif', '/docs/posters/orca-design-mode.jpg'],
  ['/docs/orca-split-screen.gif', '/docs/posters/orca-split-screen.jpg'],
  ['/whats-new/agent-statuses.gif', '/whats-new/posters/agent-statuses.jpg'],
  ['/whats-new/any-cli-agent.gif', '/whats-new/posters/any-cli-agent.jpg'],
  ['/whats-new/browser-2-demo.gif', '/whats-new/posters/browser-2-demo.jpg'],
  ['/whats-new/default-agent-opening.gif', '/whats-new/posters/default-agent-opening.jpg'],
  ['/whats-new/ghostty-style-terminal.gif', '/whats-new/posters/ghostty-style-terminal.jpg'],
  ['/whats-new/keyboard-native.gif', '/whats-new/posters/keyboard-native.jpg'],
  ['/whats-new/orca-browser-use.gif', '/whats-new/posters/orca-browser-use.jpg'],
  ['/whats-new/orca-cli-demo.gif', '/whats-new/posters/orca-cli-demo.jpg'],
  ['/whats-new/orca-github.gif', '/whats-new/posters/orca-github.jpg'],
  ['/whats-new/orca-markdown-editor.gif', '/whats-new/posters/orca-markdown-editor.jpg'],
  ['/whats-new/orca-mobile.gif', '/whats-new/posters/orca-mobile.jpg'],
  [
    '/whats-new/session-that-survives-restart.gif',
    '/whats-new/posters/session-that-survives-restart.jpg'
  ],
  ['/whats-new/ssh-demo.gif', '/whats-new/posters/ssh-demo.jpg'],
  ['/whats-new/tab-split.gif', '/whats-new/posters/tab-split.jpg']
] as const

const nextConfig: NextConfig = {
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
        source: '/whats-new/:all*(mp4|gif)',
        headers: [{ key: 'Cache-Control', value: media }]
      },
      {
        source: '/docs/posters/:path*',
        headers: [{ key: 'Cache-Control', value: media }]
      },
      {
        source: '/whats-new/posters/:path*',
        headers: [{ key: 'Cache-Control', value: media }]
      }
    ]
  }
}

const withMDX = createMDX()

export default withMDX(nextConfig)
