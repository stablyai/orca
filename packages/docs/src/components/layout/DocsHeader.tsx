import Link from 'next/link'
import Image from 'next/image'

function XIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M18.244 2H21l-6.52 7.455L22.152 22h-6.01l-4.707-6.17L6.04 22H3.28l6.973-7.97L2 2h6.163l4.255 5.593zM17.276 20.346h1.527L7.334 3.567H5.695z" />
    </svg>
  )
}

function DiscordIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.029zM8.02 15.33c-1.182 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
    </svg>
  )
}

/** Minimal open-source docs chrome — no marketing Download/Plausible/enterprise. */
export function DocsHeader() {
  return (
    <header className="fixed inset-x-0 top-0 z-50 border-b border-white/[0.08] bg-[#000000]/95 backdrop-blur-xl supports-[backdrop-filter]:bg-[#000000]/85">
      <div className="container mx-auto px-4 h-14 flex items-center justify-between max-w-[1200px] gap-4">
        <div className="flex items-center gap-6 shrink-0">
          <Link href="/docs" className="flex items-center gap-2 group shrink-0">
            <Image
              src="/logo.svg"
              alt="Orca"
              width={40}
              height={25}
              className="invert-0 brightness-100"
            />
            <span className="font-sans font-semibold text-sm tracking-tight text-white/90 group-hover:text-white transition-colors">
              ORCA
            </span>
          </Link>
          <nav className="hidden sm:flex items-center gap-5">
            <Link
              href="/docs"
              className="text-[13px] font-semibold text-white underline decoration-white/50 underline-offset-[6px]"
            >
              Docs
            </Link>
            <a
              href="https://www.onorca.dev"
              className="text-[13px] font-medium text-white/80 hover:text-white transition-colors"
            >
              Home
            </a>
            <a
              href="https://www.onorca.dev/download"
              className="text-[13px] font-medium text-white/80 hover:text-white transition-colors"
            >
              Download
            </a>
          </nav>
        </div>

        <div className="flex items-center gap-3 sm:gap-5 shrink-0">
          <a
            href="https://discord.gg/fzjDKHxv8Q"
            target="_blank"
            rel="noopener noreferrer"
            className="hidden sm:flex items-center justify-center text-white/80 hover:text-white transition-colors"
            aria-label="Join Orca on Discord"
          >
            <DiscordIcon className="w-4 h-4" />
          </a>
          <a
            href="https://x.com/orca_build"
            target="_blank"
            rel="noopener noreferrer"
            className="hidden sm:flex items-center justify-center text-white/80 hover:text-white transition-colors"
            aria-label="Follow Orca on X"
          >
            <XIcon className="w-4 h-4" />
          </a>
          <a
            href="https://github.com/stablyai/orca"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-[13px] text-white/80 hover:text-white transition-colors font-medium"
          >
            GitHub
          </a>
        </div>
      </div>
    </header>
  )
}
