import Link from 'next/link'
import Image from 'next/image'
import { MessageCircle, Star } from 'lucide-react'
import { ThemeSwitch } from 'fumadocs-ui/layouts/shared/slots/theme-switch'

async function getGithubStars(): Promise<number | undefined> {
  try {
    const response = await fetch('https://api.github.com/repos/stablyai/orca', {
      headers: { Accept: 'application/vnd.github+json' },
      next: { revalidate: 3600 }
    })
    if (!response.ok) {
      return undefined
    }
    const payload = (await response.json()) as { stargazers_count?: unknown }
    return typeof payload.stargazers_count === 'number' ? payload.stargazers_count : undefined
  } catch {
    return undefined
  }
}

function formatStars(stars: number): string {
  return stars >= 1000 ? `${(stars / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(stars)
}

export async function DocsHeader() {
  const stars = await getGithubStars()
  const formattedStars = stars === undefined ? undefined : formatStars(stars)

  return (
    <header className="fixed inset-x-0 top-0 z-30 border-b border-border bg-background/95 backdrop-blur-xl supports-[backdrop-filter]:bg-background/85">
      <div className="container mx-auto flex h-14 max-w-[1200px] items-center justify-between gap-4 px-4">
        <div className="flex shrink-0 items-center gap-6">
          <Link
            href="/docs"
            aria-label="Orca docs"
            className="group flex shrink-0 items-center gap-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <Image src="/docs/logo.svg" alt="" width={40} height={25} />
            <span
              aria-hidden="true"
              className="font-sans text-sm font-semibold tracking-tight text-foreground"
            >
              ORCA
            </span>
          </Link>
          <nav className="hidden items-center gap-5 sm:flex" aria-label="Primary navigation">
            <Link
              href="/docs"
              className="rounded-md px-2 py-1 text-[13px] font-semibold text-foreground underline decoration-border underline-offset-[6px] transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              Docs
            </Link>
            <a
              href="https://www.onorca.dev"
              className="rounded-md px-2 py-1 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              Home
            </a>
            <a
              href="https://www.onorca.dev/download"
              className="rounded-md px-2 py-1 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              Download
            </a>
          </nav>
        </div>

        <div className="flex shrink-0 items-center gap-3 sm:gap-5">
          <ThemeSwitch className="border-border bg-card" />
          <a
            href="https://discord.gg/fzjDKHxv8Q"
            target="_blank"
            rel="noopener noreferrer"
            className="hidden size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 sm:flex"
            aria-label="Join Orca on Discord"
          >
            <MessageCircle className="size-4" aria-hidden="true" />
          </a>
          <a
            href="https://x.com/orca_build"
            target="_blank"
            rel="noopener noreferrer"
            className="hidden size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 sm:flex"
            aria-label="Follow Orca on X"
          >
            <span aria-hidden="true" className="text-[15px] font-semibold leading-none">
              𝕏
            </span>
          </a>
          <a
            href="https://github.com/stablyai/orca"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <Star className="size-3.5 fill-current" aria-hidden="true" />
            <span>Star</span>
            {formattedStars && (
              <span className="rounded-full bg-accent px-1.5 py-0.5 text-[11px] font-semibold text-foreground">
                {formattedStars}
              </span>
            )}
          </a>
        </div>
      </div>
    </header>
  )
}
