# kw-repo — 이 레포(포크)의 자산 취급

> 포크 고유 문서. upstream(`stablyai/orca`)에는 없다.
> 루트에 둔 이유 = `.gitignore`에 `/notes/`가 있어 **새 파일**은 `git add`가 거부된다
> (기존 `notes/skill-*-design.md` 3개는 이미 추적 중이라 영향 없다 — ignore는 추적 중인
> 파일엔 효력이 없다. 2026-07-28 확인).
> 3-tier(git / kw-repo / 기기 로컬) 판정 정본 = `orca-system` 레포 `STRUCTURE.md`.

## 위치

`C:\Users\giloh\kw-repo\orca\` (mac `~/mnt/kw-repo/orca/`) — 2026-07-27 신설.
하위는 **git 레포 루트 기준 상대 경로 미러**다.

2026-07-28 실측 116개 47MB (`README.md` 포함):

| 경로 | 내용 |
|---|---|
| `docs/assets/` | README·기능월 GIF·JPG (`feature-wall/`, `issue-1920/` 포함) |
| `mobile/assets/` | 모바일 에셋 |
| `resources/` | 앱 아이콘·트레이·알림음·온보딩·로고 |
| `src/shared/` | 공유 바이너리 자산 |

## ⚠ 여긴 "이관처"가 아니라 **백업 미러**다

다른 레포(`work-studio`·`lab-robotics` 등)는 대용량 바이너리를 git에서 **추적 해제하고**
kw-repo를 정본으로 삼는다. **이 레포는 다르다.**

2026-07-28 실측: kw-repo에 있는 자산 115개(README 제외) **전부가 여전히 git에 tracked**다
(not-in-git = 0). 즉 git과 kw-repo에 **양쪽 다 존재**한다.

이유는 포크이기 때문이다 — `docs/assets/`·`resources/`는 upstream이 관리하는 파일이라
여기서 추적 해제하면 upstream 머지 때마다 삭제/부활이 충돌한다. **untrack 하지 말 것.**

## 규칙

1. **kw-repo에 있다는 이유로 git에서 지우지 않는다.** 위 경로는 upstream 소유다.
2. 포크 고유로 추가하는 **대용량 바이너리**만 3-tier 기준을 적용한다.
   그 경우 ignore 규칙 옆에 kw-repo 보관 경로를 주석으로 남긴다.
3. `.gitignore`를 손볼 때 — 폴더 통째 ignore 금지(파생 하위경로만), 예외는 열거가 아니라
   확장자 규칙으로. `configurator` 계열처럼 **확장자로는 소스처럼 보이지만 실제론 바이너리**인
   파일이 있으니 확장자만 보고 판단하지 않는다.
4. kw-repo 쪽 미러 갱신·인벤토리 재생성은 `orca-system` `tools/kw_index.py` 및
   `_meta/inventory.csv` 파이프라인을 쓴다. 수동 복사로 어긋내지 않는다.
