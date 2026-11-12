"""Tabulates results/*.json from the D3 harness. Usage: python3 table3.py [results-dir]"""
import json, glob, os, sys
S = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), 'results')
for f in sorted(glob.glob(S + '/*.json')):
    n = os.path.basename(f)[:-5]
    if n.endswith('.probe'):
        continue
    r = json.load(open(f)); g = r['gh']; k = g['lastHourByKind']
    reads = k.get('pr:view', 0) + k.get('graphql:sidebar', 0)
    print(f"{n:46s} spawns/h={g['perHourCounts']} lastH: prReads={reads} auth={k.get('auth:status',0)} rateLimitProbes={k.get('api:rate_limit',0)} "
          f"reqLowerBound(auth x3)={sum(k.values()) + 2 * k.get('auth:status',0)} pk60={g['lastHourRollingPeak60s']} | pk60all={g['rollingPeak60s']} pk/mean15={g['worstPeakToMean15min']}")
    s = r.get('serve')
    if s:
        print(f"      gate={s['gate']} starts={s['upstreamStarts']} max5min={s['maxStartsPer5min']} max60s={s['maxStartsPer60s']} admits={s['admits']} hits={s['cacheHits']} "
              f"lastGood={s['lastGoodServedOverBudget']} deferredCold={s['deferredCold']} deadlineHits={s['replyDeadlineHits']} fgOverflow={s['interactiveOverflow']} "
              f"legacy={s['legacy']} rpcMs={s['rpcSimulatedMs']} max={s['maxRpcSimulatedMs']} calls={s['clientRefreshCalls']} fail={s['clientFailures']} "
              f"checks={s['checksCalls']} fg={s['foregroundCalls']} lateHints={s['hintsDroppedAsLate']} afterAllGone={s['upstreamStartsAfterAllClientsGone']}")
        L = s.get('lanes')
        if L:
            for lane in ('selected-own', 'selected-borrowed', 'visible', 'interactive'):
                x = L['lanes'][lane]
                print(f"      lane {lane:18s} starts={x['starts']:5d} pk60={x['peak60s']:2d} pk5min={x['peak5min']:2d} overdueAtStartS={x['overdueAtStartS']} waitedS={x['waitedSinceFirstRefusalS']}")
            print(f"      budgeted pk60={L['budgeted']['peak60s']} pk5min={L['budgeted']['peak5min']} selectedTotal pk5min={L['selectedTotal']['peak5min']} refusals={L['refusals']} visibleIdentities={L['visibleIdentities']}")
        for i in s.get('selectedIdentities', []):
            print(f"      selected identity {i['identity']:24s} starts={i['starts']:4d} medianGapS={i['medianGapS']} maxGapS={i['maxGapS']}")
        print(f"      queueAgeByClient={s['queueAgeSecondsByClient']}")
    if r.get('detection'):
        d = r['detection']
        print('      detection events=%d undetected=%d' % (d['events'], d['undetected']), ' '.join(f"{a}:{v['samples']}/{v['p50']}/{v['p90']}/{v['max']}" for a, v in d.items() if isinstance(v, dict)), '(samples/p50/p90/max s)')
    if r.get('focusReturn'):
        print('      return', r['focusReturn'])
    if r['unknownGit'] or r['unknownGh']:
        print('      UNKNOWN', r['unknownGit'], r['unknownGh'])
