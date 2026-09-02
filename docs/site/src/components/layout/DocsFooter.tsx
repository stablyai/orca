import Link from 'next/link'
import Image from 'next/image'

export function DocsFooter() {
  return (
    <footer className="border-t border-border bg-background pb-8 pt-12">
      <div className="container mx-auto max-w-7xl px-4">
        <div className="mb-12 flex flex-col gap-10 md:flex-row md:items-start md:justify-between">
          <div>
            <Link
              href="/docs"
              aria-label="Orca docs"
              className="mb-4 inline-flex items-center gap-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <Image src="/docs/logo.svg" alt="" width={32} height={20} />
              <span
                aria-hidden="true"
                className="font-sans text-xl font-bold tracking-tight text-foreground"
              >
                ORCA
              </span>
            </Link>
            <p className="text-muted-foreground max-w-sm text-sm">
              The worktree IDE for AI coding agents. Free and open source.
            </p>
          </div>

          <div>
            <h2 className="mb-4 font-mono text-sm uppercase tracking-widest text-foreground">
              Links
            </h2>
            <ul className="space-y-3 text-sm text-muted-foreground">
              <li>
                <Link
                  href="/docs"
                  className="rounded-md px-1 py-0.5 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  Docs
                </Link>
              </li>
              <li>
                <a
                  href="https://www.onorca.dev"
                  className="rounded-md px-1 py-0.5 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  Home
                </a>
              </li>
              <li>
                <a
                  href="https://github.com/stablyai/orca"
                  className="rounded-md px-1 py-0.5 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  GitHub
                </a>
              </li>
              <li>
                <a
                  href="https://discord.gg/fzjDKHxv8Q"
                  className="rounded-md px-1 py-0.5 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  Discord
                </a>
              </li>
              <li>
                <a
                  href="https://x.com/orca_build"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-md px-1 py-0.5 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  X
                </a>
              </li>
            </ul>
          </div>
        </div>

        <div className="flex flex-col items-center justify-between gap-4 border-t border-border pt-6 font-mono text-sm text-muted-foreground md:flex-row">
          <p>
            © {new Date().getFullYear()} Lovecast Inc. ·{' '}
            <a
              href="https://github.com/stablyai/orca/blob/main/LICENSE"
              className="rounded-sm underline decoration-border underline-offset-4 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              MIT licensed
            </a>
          </p>
          <a
            href="https://github.com/stablyai/orca/tree/main/docs/site"
            className="rounded-sm text-xs underline decoration-border underline-offset-4 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            Docs source: docs/site in stablyai/orca
          </a>
        </div>
      </div>
    </footer>
  )
}
