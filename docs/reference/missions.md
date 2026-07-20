# Missions: 여러 Git repository를 하나의 작업 세션에서 다루기

Mission은 여러 Git repository에 걸친 한 작업을 하나의 Orca 세션으로 묶는다. 각 repository에는 같은 이름의 branch를 사용하는 별도 managed worktree를 만들고, 그 실제 checkout directory를 Mission root의 직접 자식으로 배치한다. 따라서 symlink를 따라가지 않는 file discovery와 sandbox에서도 agent와 terminal이 모든 member repository를 함께 읽고 수정할 수 있으며, 원래 clone의 checkout과 현재 branch는 바뀌지 않는다.

## 생성 흐름

1. 사이드바의 Missions 탭에서 `New Mission`을 선택한다.
2. Mission 이름, 공통 branch, member project, 시작 agent를 선택한다.
3. Orca는 configured `workspaceDir` 옆의 `missions` directory에 Mission ID가 포함된 고유 root를 만들고, Mission과 root 정보를 disk에 먼저 저장한다.
4. Orca는 각 Git repository에 managed worktree를 순서대로 만들며 실제 directory를 root 바로 아래에 둔다. 모든 worktree는 요청한 공통 branch 이름을 정확히 사용하며, filesystem path 충돌만 별도 suffix로 해결한다.
5. Mission row를 열면 하나의 folder-workspace session이 이 root에서 시작된다.

Mission 생성 중 일부 repository만 실패할 수 있다. 성공한 worktree와 repository별 오류는 유지되며, 실패 row의 `Recreate`로 다시 시도할 수 있다. `git worktree add` 직전에는 Mission root에 create intent를 atomic하게 기록하고 file을 flush한다. Git add가 끝나면 linked-worktree Git admin directory의 ownership marker로 승격한 뒤 intent를 제거한다. 두 단계 사이에 process가 중단되면 재시도 시 strict Git 목록, repository, path, branch, marker instance를 검증해 checkout을 채택하고 누락된 metadata와 member pointer를 복구한다. Git에 등록되지 않았지만 target directory가 남아 있으면 사용자 data일 수 있으므로 자동 삭제하거나 소유하지 않는다.

## V1 host 범위

현재 Mission은 이 컴퓨터의 native filesystem에서 실행되는 local Git project만 지원한다.

- 지원: macOS, Linux 또는 Windows host에서 직접 실행되는 local Git repository
- 미지원: folder project, SSH repository, runtime-environment repository, WSL 실행 project와 WSL UNC path

지원하지 않는 project는 picker에서 숨기며 main-process IPC에서도 다시 거부한다. SSH 또는 WSL project를 local Mission에 섞으면 하나의 local session이 모든 path에 접근할 수 없기 때문이다. Remote Mission은 향후 동일 실행 host에 root와 session을 함께 만드는 별도 모델이 필요하다.

## 삭제와 복구 안전성

- Mission worktree를 link하거나 삭제하기 전에 `repoId`, `missionId`, `worktreeInstanceId`와 linked-worktree Git admin directory의 소유권 marker가 모두 일치해야 한다. 외부 Git 작업이 같은 path와 branch를 재사용해도 이전 Mission 소유권으로 인정하지 않는다.
- 삭제 전 Git worktree 목록은 cache나 metadata fallback 없이 strict하게 다시 읽는다. 조회 실패나 timeout은 worktree 부재로 간주하지 않고 member와 소유권 metadata를 보존한 채 재시도를 요구한다.
- Mission 또는 member worktree를 삭제하기 전에 shared Mission session의 PTY를 종료한다.
- 새 Mission의 member는 root의 실제 자식이므로, Mission이 남아 있는 동안 member만 제거하려면 확인 후 해당 workspace도 함께 삭제한다. Checkout을 root 안에 남긴 채 membership만 제거하는 동작은 허용하지 않는다.
- Mission만 삭제하고 member workspace를 보존하도록 선택하면 checkout과 non-empty root를 former Mission root에 그대로 남긴다. 이후 일반 project workspace로 보이지만 자동으로 다른 경로로 이동하지는 않는다.
- 보존 삭제는 Mission과 shared session 삭제를 disk에 동기 저장한 뒤 ownership marker를 제거한다. 저장에 실패하면 Mission, session, workspace lineage를 메모리에 복원해 일반 worktree/project 삭제 방지 경계를 유지한다.
- 일반 Projects/CLI worktree 삭제와 project 제거는 live Mission member를 직접 변경할 수 없다. Mission lifecycle을 통해서만 ownership marker와 member record를 함께 갱신한다.
- Add가 끝났지만 ownership marker를 쓰지 못한 create intent도 live Mission 소유권으로 취급하므로 일반 worktree 삭제로 우회할 수 없다. 재사용한 기존 local branch의 보존 정책도 marker에 기록해 crash 복구 뒤 삭제가 branch를 지우지 않게 한다.
- Mission 경로에서는 신뢰 확인 없이 setup/archive hook을 실행하지 않는다.
- Dirty worktree 삭제가 실패하면 해당 member와 오류를 Mission에 남겨 사용자가 수정 후 재시도할 수 있다.
- 안전을 위해 보존한 local branch가 있으면 삭제 결과에 이를 알린다.
- Mission root는 trusted `missions` base의 직접 자식만 허용하며 symlink/junction root를 거부한다.
- Root를 처음 만들 때 trusted base도 함께 저장하므로 이후 `workspaceDir` 설정이 바뀌어도 기존 root를 같은 기준으로 검증한다.
- 새 member worktree directory는 일반 directory entry로 보존·삭제하며 root cleanup이 재귀 삭제하지 않는다. Root marker의 link 목록은 이전 버전에서 만든 out-of-root member의 compatibility link만 추적한다.
- 일반 파일, 사용자 link, 외부에서 교체된 compatibility link 또는 보존한 worktree가 남아 있으면 directory 전체를 재귀 삭제하지 않고 root와 내용을 보존한다.
- Mission만 삭제하고 checkout을 보존할 때는 root cleanup보다 먼저 모든 member를 strict scan한다. Add 시작 전 intent는 target과 Git 등록이 모두 없을 때만 제거하고, add 후 checkout은 ownership marker와 member pointer로 승격해 disk에 저장한다. 조회 실패나 모호한 후보는 Mission을 남긴 채 중단한다. 그 뒤 empty root는 정리하고 실제 child checkout은 보존한다.
- Root marker는 같은 directory의 temporary file에 쓴 뒤 atomic rename하므로 중간 JSON이 persisted state로 남지 않는다.

이 기능은 기존 worktree 생성·삭제 경로를 재사용하므로 Git core workflow의 2.25 baseline을 유지한다.
