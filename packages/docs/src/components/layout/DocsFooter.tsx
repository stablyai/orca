import Link from 'next/link'
import Image from 'next/image'

export function DocsFooter() {
  return (
    <footer className="border-t border-white/5 bg-background pt-12 pb-8">
      <div className="container mx-auto px-4 max-w-7xl">
        <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-10 mb-12">
          <div>
            <Link href="/docs" className="flex items-center gap-2 mb-4">
              <Image src="/logo.svg" alt="Orca" width={32} height={20} />
              <span className="font-display font-bold text-xl tracking-tight text-white/90">
                ORCA
              </span>
            </Link>
            <p className="text-muted-foreground max-w-sm text-sm">
              The worktree IDE for AI coding agents. Free and open source.
            </p>
          </div>

          <div>
            <h4 className="font-mono text-sm uppercase tracking-widest text-white/80 mb-4">
              Links
            </h4>
            <ul className="space-y-3 text-sm text-muted-foreground">
              <li>
                <Link href="/docs" className="hover:text-primary transition-colors">
                  Docs
                </Link>
              </li>
              <li>
                <a href="https://www.onorca.dev" className="hover:text-primary transition-colors">
                  Home
                </a>
              </li>
              <li>
                <a
                  href="https://github.com/stablyai/orca"
                  className="hover:text-primary transition-colors"
                >
                  GitHub
                </a>
              </li>
              <li>
                <a
                  href="https://discord.gg/fzjDKHxv8Q"
                  className="hover:text-primary transition-colors"
                >
                  Discord
                </a>
              </li>
            </ul>
          </div>
        </div>

        <div className="border-t border-white/5 pt-6 flex flex-col md:flex-row items-center justify-between gap-4 text-sm text-muted-foreground font-mono">
          <p>© {new Date().getFullYear()} Lovecast Inc. All rights reserved.</p>
          <p className="text-xs">Docs source: packages/docs in stablyai/orca</p>
        </div>
      </div>
    </footer>
  )
}
