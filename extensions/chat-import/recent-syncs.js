// recent-syncs.js
// 순수 링버퍼: background(기록)와 popup(렌더) 양쪽에서 import한다.
// entry shape: { id, title, source, date }. id는 대화의 안정적 externalId —
// 제목("New chat" 등)은 서로 다른 대화끼리 겹칠 수 있어 dedup 키로 쓸 수 없다.
export function pushRecentSync(list, entry, cap) {
  const next = [entry, ...list.filter((e) => !(e.source === entry.source && e.id === entry.id))]
  return next.slice(0, cap)
}

export function topRecentSyncs(list, n) {
  return [...list].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)).slice(0, n)
}
