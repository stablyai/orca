import json,glob,os
S=os.path.dirname(os.path.abspath(__file__))
for f in sorted(glob.glob(S+'/results/*.json')):
    r=json.load(open(f));g=r['gh'];n=os.path.basename(f)[:-5]
    k=g['lastHourByKind']
    starts=k.get('pr:view',0)+k.get('graphql:sidebar',0)
    print(f"{n:44s} perHour={g['perHourCounts'][:4]} lastH: starts={starts} auth={k.get('auth:status',0)} rl={k.get('api:rate_limit',0)} pk60={g['lastHourRollingPeak60s']} | pk60all={g['rollingPeak60s']} pk/mean={g['worstPeakToMean15min']}")
    if r.get('serve'):
        s=r['serve']; print(f"      starts={s['upstreamStarts']} max5={s['maxStartsPer5min']} admits={s['admits']} hits={s['cacheHits']} lastGood={s['lastGoodServedOverBudget']} deferred={s['deferredCold']} maxRpcMs={s['maxRpcSimulatedMs']} q={s['queueAgeSecondsByClient']} calls={s['clientRefreshCalls']} fail={s['clientFailures']}")
    if r.get('detection'):
        d=r['detection']; print('      det ev=%d undetected=%d'%(d['events'],d['undetected']), ' '.join(f"{k}:{v['samples']}/{v['p50']}/{v['p90']}/{v['max']}" for k,v in d.items() if isinstance(v,dict)))
    if r.get('focusReturn'): print('      return',r['focusReturn'])
    if r['unknownGit'] or r['unknownGh']: print('      UNKNOWN',r['unknownGit'],r['unknownGh'])
