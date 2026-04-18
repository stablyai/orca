import type { PRInfo, IssueInfo, CheckStatus, PRCheckDetail } from '../../shared/types';
export declare function mapCheckRunRESTStatus(status: string): PRCheckDetail['status'];
export declare function mapCheckRunRESTConclusion(status: string, conclusion: string | null): PRCheckDetail['conclusion'];
export declare function mapCheckStatus(state: string): PRCheckDetail['status'];
export declare function mapCheckConclusion(state: string): PRCheckDetail['conclusion'];
export declare function mapPRState(state: string, isDraft?: boolean): PRInfo['state'];
export declare function mapIssueInfo(data: {
    number: number;
    title: string;
    state: string;
    url?: string;
    html_url?: string;
    labels?: {
        name: string;
    }[];
}): IssueInfo;
export declare function deriveCheckStatus(rollup: unknown[] | null | undefined): CheckStatus;
