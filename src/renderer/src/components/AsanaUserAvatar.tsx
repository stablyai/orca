import type { AsanaUser } from '../../../shared/types'

// Why: mirrors the GitHub composer's assignee avatar — render the user's Asana
// profile photo when present, falling back to an initial in a muted circle.
export function AsanaUserAvatar({ user }: { user: AsanaUser }): React.JSX.Element {
  if (user.photoUrl) {
    return (
      <img
        src={user.photoUrl}
        alt={user.name}
        loading="lazy"
        decoding="async"
        title={user.name}
        className="size-5 shrink-0 rounded-full border border-border/40 bg-muted object-cover"
      />
    )
  }
  return (
    <span
      title={user.name}
      className="inline-flex size-5 shrink-0 items-center justify-center rounded-full border border-border/40 bg-muted text-[10px] font-medium text-muted-foreground"
    >
      {user.name.slice(0, 1).toUpperCase()}
    </span>
  )
}
