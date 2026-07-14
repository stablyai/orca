// recent-syncs.js
// 순수 링버퍼: background(기록)와 popup(렌더) 양쪽에서 import한다.
export function pushRecentSync(list, entry, cap) {
  const next = [
    entry,
    ...list.filter((e) => !(e.source === entry.source && e.title === entry.title))
  ]
  return next.slice(0, cap)
}

export function topRecentSyncs(list, n) {
  return [...list].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)).slice(0, n)
}
